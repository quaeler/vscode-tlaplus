import { Range } from 'vscode';
import { ProcessOutputParser } from '../tla2tools';
import { Readable } from 'stream';
import { CheckStatus, ModelCheckResult, InitialStateStatItem, CoverageItem, ErrorTraceItem,
    VariableValue, CheckState, OutputLine} from '../model/check';
import { parseValueLines } from './tlcValues';
import { SanyStdoutParser } from './sany';
import { DCollection } from '../diagnostic';
import { pathToModuleName, parseDateTime } from '../common';
import * as moment from 'moment/moment';
import { clearTimeout } from 'timers';

const STATUS_EMIT_TIMEOUT = 500;    // msec

// TLC message types
const NONE = -1;
const TLC_UNKNOWN = -2;
const GENERAL = 1000;
const TLC_MODE_MC = 2187;
const TLC_SANY_START = 2220;
const TLC_SANY_END = 2219;
const TLC_CHECKPOINT_START = 2195;
const TLC_STARTING = 2185;
const TLC_COMPUTING_INIT = 2189;
const TLC_COMPUTING_INIT_PROGRESS = 2269;
const TLC_INIT_GENERATED1 = 2190;
const TLC_INIT_GENERATED2 = 2191;
const TLC_INIT_GENERATED3 = 2207;
const TLC_INIT_GENERATED4 = 2208;
const TLC_CHECKING_TEMPORAL_PROPS = 2192;
const TLC_DISTRIBUTED_SERVER_RUNNING = 7000;
const TLC_DISTRIBUTED_WORKER_REGISTERED = 7001;
const TLC_DISTRIBUTED_WORKER_DEREGISTERED = 7002;
const TLC_COVERAGE_NEXT = 2772;
const TLC_COVERAGE_INIT = 2773;
const TLC_PROGRESS_STATS = 2200;
const TLC_TEMPORAL_PROPERTY_VIOLATED = 2116;
const TLC_INITIAL_STATE = 2102;
const TLC_NESTED_EXPRESSION = 2103;
const TLC_VALUE_ASSERT_FAILED = 2132;
const TLC_STATE_PRINT1 = 2216;
const TLC_STATE_PRINT2 = 2217;
const TLC_STATE_PRINT3 = 2218;
const TLC_FINISHED = 2186;
const TLC_SUCCESS = 2193;

/**
 * Parses stdout of TLC model checker.
 */
export class TLCModelCheckerStdoutParser extends ProcessOutputParser {
    checkResultBuilder: ModelCheckResultBuilder;
    handler: (checkResult: ModelCheckResult) => void;
    timer: NodeJS.Timer | undefined = undefined;
    first: boolean = true;

    constructor(stdout: Readable | string[], filePath: string, handler: (checkResult: ModelCheckResult) => void) {
        super(stdout, filePath);
        this.handler = handler;
        const moduleName = pathToModuleName(filePath);
        this.checkResultBuilder = new ModelCheckResultBuilder(moduleName);
    }

    protected parseLine(line: string | null) {
        if (line !== null) {
            this.checkResultBuilder.addLine(line);
            this.scheduleUpdate();
        } else {
            this.checkResultBuilder.handleStop();
            // Copy SANY messages
            const dCol = this.checkResultBuilder.getSanyMessages();
            if (dCol) {
                this.addDiagnosticCollection(dCol);
            }
            // Issue the last update
            this.issueUpdate();
        }
    }

    private scheduleUpdate() {
        if (this.timer) {
            return;
        }
        let timeout = STATUS_EMIT_TIMEOUT;
        if (this.first && this.checkResultBuilder.getStatus() !== CheckStatus.NotStarted) {
            // First status change, show immediately
            this.first = false;
            timeout = 0;
        }
        const me = this;
        this.timer = setTimeout(() => {
            me.issueUpdate();
        }, timeout);
    }

    private issueUpdate() {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.handler(this.checkResultBuilder.build());
        this.timer = undefined;
    }
}

/**
 * TLC output message;
 */
class Message {
    readonly lines: string[] = [];

    constructor(readonly type: number) {}
}

/**
 * Tracks hierarchy of TLC output messages.
 */
class MessageStack {
    private static NO_MESSAGE = new Message(NONE);

    private current: Message = MessageStack.NO_MESSAGE;
    private previous: Message[] = [];

    public getCurrentType(): number {
        return this.current.type;
    }

    public start(type: number) {
        if (type === NONE) {
            throw Error('Cannot start message of type NONE');
        }
        if (this.current.type !== NONE) {
            this.previous.push(this.current);
        }
        this.current = new Message(type);
    }

    public finish(): Message {
        if (this.current.type === NONE) {
            console.error('Unexpected message end');
            return MessageStack.NO_MESSAGE;
        }
        const finished = this.current;
        this.current = this.previous.pop() || MessageStack.NO_MESSAGE;
        return finished;
    }

    public addLine(line: string) {
        if (this.current.type === NONE) {
            console.error("Unexpected line when there's no current message");
            return;
        }
        this.current.lines.push(line);
    }
}

/**
 * Gradually builds ModelCheckResult by processing TLC output lines.
 */
class ModelCheckResultBuilder {
    private state: CheckState = CheckState.Running;
    private status: CheckStatus = CheckStatus.NotStarted;
    private startDateTime: moment.Moment | undefined;
    private endDateTime: moment.Moment | undefined;
    private duration: number | undefined;       // msec
    private processInfo: string | undefined;
    private initialStatesStat: InitialStateStatItem[] = [];
    private coverageStat: CoverageItem[] = [];
    private errors: string[][] = [];
    private errorTrace: ErrorTraceItem[] = [];
    private messages = new MessageStack();
    private sanyLines: string[] = [];
    private sanyMessages: DCollection | undefined;
    private outputLines: OutputLine[] = [];
    private workersCount: number = 0;
    private firstStatTime: moment.Moment | undefined;
    private fingerprintCollisionProbability: string | undefined;

    constructor(private modelName: string) {
    }

    getStatus(): CheckStatus {
        return this.status;
    }

    getSanyMessages(): DCollection | undefined {
        return this.sanyMessages;
    }

    addLine(line: string) {
        const newMsgType = this.tryParseMessageStart(line);
        if (newMsgType != null) {
            this.messages.start(newMsgType);
            return;
        }
        if (this.tryParseMessageEnd(line)) {
            const message = this.messages.finish();
            this.handleMessageEnd(message);
            return;
        }
        if (line === '') {
            return;
        }
        if (this.status === CheckStatus.SanyParsing) {
            this.sanyLines.push(line);
            return;
        }
        if (this.messages.getCurrentType() !== NONE) {
            this.messages.addLine(line);
            return;
        }
        this.addOutputLine(line);
    }

    handleStop() {
        if (this.status !== CheckStatus.Finished) {
            // The process wasn't finished as expected, hence it was stopped manually
            this.state = CheckState.Stopped;
        }
    }

    build(): ModelCheckResult {
        return new ModelCheckResult(
            this.modelName,
            this.state,
            this.status,
            this.processInfo,
            this.initialStatesStat,
            this.coverageStat,
            this.errors,
            this.errorTrace,
            this.sanyMessages,
            this.startDateTime,
            this.endDateTime,
            this.duration,
            this.workersCount,
            this.fingerprintCollisionProbability,
            this.outputLines
        );
    }

    private handleMessageEnd(message: Message) {
        if (this.status === CheckStatus.NotStarted) {
            this.status = CheckStatus.Starting;
        }
        switch (message.type) {
            case TLC_MODE_MC:
                this.processInfo = message.lines.join('');
                break;
            case TLC_SANY_START:
                this.status = CheckStatus.SanyParsing;
                break;
            case TLC_SANY_END:
                this.status = CheckStatus.SanyFinished;
                this.parseSanyOutput();
                break;
            case TLC_CHECKPOINT_START:
                this.status = CheckStatus.Checkpointing;
                break;
            case TLC_STARTING:
                this.parseStarting(message.lines);
                break;
            case TLC_COMPUTING_INIT:
                this.status = CheckStatus.InitialStatesComputing;
                break;
            case TLC_COMPUTING_INIT_PROGRESS:
                this.status = CheckStatus.InitialStatesComputing;
                break;
            case TLC_INIT_GENERATED1:
            case TLC_INIT_GENERATED2:
            case TLC_INIT_GENERATED3:
            case TLC_INIT_GENERATED4:
                this.parseInitialStatesComputed(message.lines);
                break;
            case TLC_CHECKING_TEMPORAL_PROPS:
                if (message.lines.length > 0 && message.lines[0].indexOf('complete') >= 0) {
                    this.status = CheckStatus.CheckingLivenessFinal;
                } else {
                    this.status = CheckStatus.CheckingLiveness;
                }
                break;
            case TLC_DISTRIBUTED_SERVER_RUNNING:
                this.status = CheckStatus.ServerRunning;
                break;
            case TLC_DISTRIBUTED_WORKER_REGISTERED:
                this.status = CheckStatus.WorkersRegistered;
                this.workersCount += 1;
                break;
            case TLC_DISTRIBUTED_WORKER_DEREGISTERED:
                this.workersCount -= 1;
                break;
            case TLC_PROGRESS_STATS:
                this.parseProgressStats(message.lines);
                break;
            case TLC_COVERAGE_INIT:
                this.coverageStat.length = 0;
                this.parseCoverage(message.lines);
                break;
            case TLC_COVERAGE_NEXT:
                this.parseCoverage(message.lines);
                break;
            case GENERAL:
            case TLC_INITIAL_STATE:
            case TLC_NESTED_EXPRESSION:
            case TLC_TEMPORAL_PROPERTY_VIOLATED:
            case TLC_VALUE_ASSERT_FAILED:
                this.parseErrorMessage(message.lines);
                break;
            case TLC_STATE_PRINT1:
            case TLC_STATE_PRINT2:
            case TLC_STATE_PRINT3:
                this.parseErrorTraceItem(message.lines);
                break;
            case TLC_SUCCESS:
                this.parseSuccess(message.lines);
                this.state = CheckState.Success;
                break;
            case TLC_FINISHED:
                this.status = CheckStatus.Finished;
                this.parseFinished(message.lines);
                if (this.state !== CheckState.Success) {
                    this.state = CheckState.Error;
                }
                break;
        }
    }

    private tryParseMessageStart(line: string): number | null {
        const markerIdx = line.indexOf('@!@!@STARTMSG ');
        let markerBody = line;
        if (markerIdx < 0 || !line.endsWith(' @!@!@')) {
            return null;
        } else if (markerIdx > 0) {
            markerBody = line.substring(markerIdx);
            if (this.messages.getCurrentType() !== NONE) {
                this.messages.addLine(line.substring(0, markerIdx));
            }
        }
        const eLine = markerBody.substring(14, line.length - 6);
        const parts = eLine.split(':');
        if (parts.length > 0) {
            return parseInt(parts[0]);
        }
        return TLC_UNKNOWN;
    }

    private tryParseMessageEnd(line: string): boolean {
        return line.startsWith('@!@!@ENDMSG ') && line.endsWith(' @!@!@');
    }

    private parseStarting(lines: string[]) {
        const matches = this.tryMatchBufferLine(lines, /^Starting\.\.\. \((\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\)$/g);
        if (matches) {
            this.startDateTime = parseDateTime(matches[1]);
        }
    }

    private parseSuccess(lines: string[]) {
        const matches = this.tryMatchBufferLine(lines, /calculated \(optimistic\):\s+val = (.+)$/g, 3);
        if (matches) {
            this.fingerprintCollisionProbability = matches[1];
        }
    }

    private parseFinished(lines: string[]) {
        const matches = this.tryMatchBufferLine(lines, /^Finished in (\d+)ms at \((\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\)$/g);
        if (matches) {
            this.duration = parseInt(matches[1]);
            this.endDateTime = parseDateTime(matches[2]);
        }
    }

    private parseSanyOutput() {
        const sany = new SanyStdoutParser(this.sanyLines);
        this.sanyMessages = sany.readAllSync();
    }

    private parseInitialStatesComputed(lines: string[]) {
        const matches = this.tryMatchBufferLine(lines, /^Finished computing initial states: (\d+) distinct states generated at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*$/g);
        if (matches) {
            const count = parseInt(matches[1]);
            this.firstStatTime = parseDateTime(matches[2]);
            this.initialStatesStat.push(new InitialStateStatItem('00:00:00', 0, count, count, count));
        }
    }

    private parseProgressStats(lines: string[]) {
        const matches = this.tryMatchBufferLine(lines, /^Progress\(([\d,]+)\) at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}): ([\d,]+) states generated.*, ([\d,]+) distinct states found.*, ([\d,]+) states left on queue.*/g);
        if (matches) {
            this.initialStatesStat.push(new InitialStateStatItem(
                this.calcTimestamp(matches[2]),
                parseIntWithComma(matches[1]),
                parseIntWithComma(matches[3]),
                parseIntWithComma(matches[4]),
                parseIntWithComma(matches[5])
            ));
        }
    }

    private parseCoverage(lines: string[]) {
        const matches = this.tryMatchBufferLine(lines, /^<(\w+) line (\d+), col (\d+) to line (\d+), col (\d+) of module (\w+)>: (\d+):(\d+)/g);
        if (matches) {
            this.coverageStat.push(new CoverageItem(
                matches[6],
                matches[1],
                new Range(
                    parseInt(matches[2]),
                    parseInt(matches[3]),
                    parseInt(matches[4]),
                    parseInt(matches[5])
                ),
                parseInt(matches[7]),
                parseInt(matches[8])
            ));
        }
    }

    private parseErrorMessage(lines: string[]) {
        if (lines.length === 0) {
            return;
        }
        if (lines[0] === 'TLC threw an unexpected exception.' && this.errors.length > 0) {
            // Such message must be combined with the previous one (that was actually nested)
            const prevError = this.errors[this.errors.length - 1];
            this.errors[this.errors.length - 1] = lines.concat(prevError);
        } else {
            this.errors.push(lines);
        }
    }

    private parseErrorTraceItem(lines: string[]) {
        if (lines.length === 0) {
            console.log('Error trace expected but message buffer is empty');
            return;
        }
        // Try special cases like <Initial predicate>, <Stuttering>, etc.
        const sMatches = this.tryMatchBufferLine(lines, /^(\d+): <([\w\s]+)>$/g);
        if (sMatches) {
            this.errorTrace.push(new ErrorTraceItem(
                parseInt(sMatches[1]),
                sMatches[2],
                '', '', new Range(0, 0, 0, 0), this.parseErrorTraceVariables(lines)));
            return;
        }
        // Otherwise fall back to simple states
        const matches = this.tryMatchBufferLine(lines, /^(\d+): <(\w+) line (\d+), col (\d+) to line (\d+), col (\d+) of module (\w+)>$/g);
        if (!matches) {
            return;
        }
        this.errorTrace.push(new ErrorTraceItem(
            parseInt(matches[1]),
            `${matches[2]} in ${matches[7]}`,
            matches[7],
            matches[2],
            new Range(
                parseInt(matches[3]),
                parseInt(matches[4]),
                parseInt(matches[5]),
                parseInt(matches[6])),
            this.parseErrorTraceVariables(lines)
        ));
    }

    private parseErrorTraceVariables(lines: string[]): VariableValue[] {
        const variables = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            const matches = /^\/\\ (\w+) = (.+)$/g.exec(line);
            if (matches) {
                const name = matches[1];
                const valueLines = [matches[2]];
                this.readValueLines(i + 1, valueLines);
                i += valueLines.length - 1;
                const value = parseValueLines(valueLines);
                variables.push(new VariableValue(name, value));
            }
        }
        return variables;
    }

    private readValueLines(startIdx: number, lines: string[]) {
        for (let i = startIdx; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('/\\ ')) {
                return i;
            }
            lines.push(line.trim());
        }
    }

    private tryMatchBufferLine(lines: string[], regExp: RegExp, n?: number): RegExpExecArray | null {
        const en = n ? n : 0;
        if (lines.length < en + 1) {
            return null;
        }
        return regExp.exec(lines[en]);
    }

    private calcTimestamp(timeStr: string): string {
        if (!this.firstStatTime) {
            return '??:??:??';
        }
        const time = parseDateTime(timeStr);
        const durMsec = time.diff(this.firstStatTime);
        const dur = moment.duration(durMsec);
        const sec = leftPadTimeUnit(dur.seconds());
        const min = leftPadTimeUnit(dur.minutes());
        const hour = leftPadTimeUnit(Math.floor(dur.asHours())); // days are converted to hours
        return `${hour}:${min}:${sec}`;
    }

    private addOutputLine(line: string) {
        const prevLine = this.outputLines.length > 0 ? this.outputLines[this.outputLines.length - 1] : undefined;
        if (prevLine && prevLine.text === line) {
            prevLine.increment();
        } else {
            this.outputLines.push(new OutputLine(line));
        }
    }
}

function parseIntWithComma(str: string): number {
    const c = str.split(',').join('');
    return parseInt(c);
}

function leftPadTimeUnit(n: number): string {
    return n < 10 ? '0' + n : String(n);
}