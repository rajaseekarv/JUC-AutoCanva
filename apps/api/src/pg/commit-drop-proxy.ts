import net from 'node:net';

// A loopback TCP proxy between one gate actor and the isolated PostgreSQL
// server that drops the connection around a COMMIT (§10.1 "ambiguous
// commits", gates A, B, and O). It understands just enough of the
// PostgreSQL frontend/backend protocol (v3) to find message boundaries:
// - the untyped startup phase (SSLRequest, GSSENCRequest, startup);
// - typed messages afterwards. SQL is executed by 'Q' (simple query) or by
//   'B' (Bind) of a statement prepared earlier with 'P' (Parse), named or
//   unnamed. A prepared statement can be bound many times, so a statement is
//   classified when it is bound, never when it is parsed.
// Modes for the armed COMMIT:
// - 'before-forward': the COMMIT is never sent; both sockets are destroyed,
//   so the server sees the client vanish mid-transaction and rolls back.
// - 'after-ack': the COMMIT is forwarded, and the client is cut off as soon
//   as the server's CommandComplete (or ErrorResponse) for it arrives, before
//   the client can read it. The server has committed; the client cannot know.
// How Prisma frames transactions (simple or extended protocol; whether a
// raw query outside $transaction carries BEGIN/COMMIT) is not documented and
// was not observable from its compiled engine, so the proxy handles every
// framing, records a transcript of transaction-control kinds, and the gates
// calibrate against it and fail explicitly when an assumption does not hold.
// TLS cannot be parsed, so proxied URLs set sslmode=disable (see url()).
// Used only by the gates; it listens and connects on 127.0.0.1 only.

export type CommitDropMode = 'before-forward' | 'after-ack';

// Statement kinds kept in the transcript. SQL text is never recorded.
export type ControlKind = 'BEGIN' | 'COMMIT' | 'ROLLBACK' | 'OTHER';

export type TranscriptEntry = {
  connection: number;
  protocol: 'simple' | 'extended';
  kind: ControlKind;
};

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;

export function controlKind(sql: string): ControlKind {
  if (/^\s*(BEGIN|START\s+TRANSACTION)\b/i.test(sql)) return 'BEGIN';
  if (/^\s*(COMMIT|END)\b/i.test(sql)) return 'COMMIT';
  if (/^\s*ROLLBACK\b/i.test(sql)) return 'ROLLBACK';
  return 'OTHER';
}

type Armed = {
  mode: CommitDropMode;
  remaining: number;
  // Only a COMMIT ending a transaction that executed a matching statement
  // counts; without it, every COMMIT counts.
  within: RegExp | null;
  refuseAfterDrop: boolean;
};

// Accumulates bytes and yields whole messages. `startsTyped` is asked about
// each untyped message as it is framed, so a startup message and the first
// query arriving in one chunk are still split correctly.
class Framer {
  private buffer = Buffer.alloc(0);
  typed = false;

  constructor(
    private readonly startsTyped: (bytes: Buffer) => boolean = () => false,
  ) {}

  push(chunk: Buffer): Array<{ type: string | null; bytes: Buffer }> {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: Array<{ type: string | null; bytes: Buffer }> = [];
    for (;;) {
      if (this.typed) {
        if (this.buffer.length < 5) break;
        const length = this.buffer.readInt32BE(1);
        if (this.buffer.length < 1 + length) break;
        messages.push({
          type: String.fromCharCode(this.buffer[0]),
          bytes: this.buffer.subarray(0, 1 + length),
        });
        this.buffer = this.buffer.subarray(1 + length);
      } else {
        if (this.buffer.length < 4) break;
        const length = this.buffer.readInt32BE(0);
        if (this.buffer.length < length) break;
        const bytes = this.buffer.subarray(0, length);
        messages.push({ type: null, bytes });
        this.buffer = this.buffer.subarray(length);
        if (this.startsTyped(bytes)) this.typed = true;
      }
    }
    return messages;
  }
}

// Reads the NUL-terminated strings at the start of a message body.
function cstrings(body: Buffer, count: number): string[] | null {
  const values: string[] = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const end = body.indexOf(0, offset);
    if (end < 0) return null;
    values.push(body.subarray(offset, end).toString('utf8'));
    offset = end + 1;
  }
  return values;
}

// The SQL text of a 'Q' message, or of a 'P' message with its statement
// name; null for anything else.
export function sqlOf(type: string | null, bytes: Buffer): string | null {
  if (type === 'Q') return bytes.subarray(5, bytes.length - 1).toString('utf8');
  if (type === 'P') return cstrings(bytes.subarray(5), 2)?.[1] ?? null;
  return null;
}

export class CommitDropProxy {
  private armed: Armed | null = null;
  private refusing = false;
  private connections = 0;
  private readonly sockets = new Set<net.Socket>();
  // How many COMMITs were dropped, for assertions.
  dropped = 0;
  // Executed statement kinds, in order, across connections.
  readonly transcript: TranscriptEntry[] = [];

  private constructor(
    private readonly server: net.Server,
    readonly port: number,
  ) {}

  static async start(target: {
    host: string;
    port: number;
  }): Promise<CommitDropProxy> {
    if (target.host !== '127.0.0.1')
      throw new Error('Refusing to proxy anything but 127.0.0.1');
    // Set synchronously once listening; a connection cannot arrive earlier.
    const holder: { proxy?: CommitDropProxy } = {};
    const server = net.createServer((client) => {
      if (holder.proxy) holder.proxy.accept(client, target);
      else client.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('proxy has no port');
    holder.proxy = new CommitDropProxy(server, address.port);
    return holder.proxy;
  }

  // The same database URL, through this proxy, without TLS.
  url(base: string): string {
    const url = new URL(base);
    url.hostname = '127.0.0.1';
    url.port = String(this.port);
    url.searchParams.set('sslmode', 'disable');
    return url.toString();
  }

  // Drops around the nth matching COMMIT from now on, on any connection.
  arm(
    mode: CommitDropMode,
    options: { nth?: number; within?: RegExp; refuseAfterDrop?: boolean } = {},
  ): void {
    this.armed = {
      mode,
      remaining: options.nth ?? 1,
      within: options.within ?? null,
      refuseAfterDrop: options.refuseAfterDrop ?? false,
    };
  }

  disarm(): void {
    this.armed = null;
  }

  get isArmed(): boolean {
    return this.armed !== null;
  }

  // While refusing, new client connections are closed on arrival, so a
  // verification re-read through this proxy fails (gate B).
  refuse(refusing: boolean): void {
    this.refusing = refusing;
  }

  clearTranscript(): void {
    this.transcript.length = 0;
  }

  // Transaction-control kinds seen since the transcript was cleared.
  controlKinds(): ControlKind[] {
    return this.transcript
      .map((entry) => entry.kind)
      .filter((kind) => kind !== 'OTHER');
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private accept(
    client: net.Socket,
    target: { host: string; port: number },
  ): void {
    if (this.refusing) {
      client.destroy();
      return;
    }
    const connection = (this.connections += 1);
    const upstream = net.connect(target.port, target.host);
    this.sockets.add(client);
    this.sockets.add(upstream);
    const fromServer = new Framer();
    // After a startup message (anything but an SSL or GSS request), every
    // frontend message is typed, and so is every backend message.
    const fromClient = new Framer((bytes) => {
      const code = bytes.readInt32BE(4);
      const started = code !== SSL_REQUEST && code !== GSSENC_REQUEST;
      if (started) fromServer.typed = true;
      return started;
    });
    // Prepared statements on this connection, by name ('' is unnamed).
    const prepared = new Map<string, string>();
    // SQL executed since the current transaction began, for `within`.
    let transaction: string[] = [];
    let awaitingAck = false;
    let closed = false;
    const cut = () => {
      if (closed) return;
      closed = true;
      client.destroy();
      upstream.destroy();
      this.sockets.delete(client);
      this.sockets.delete(upstream);
    };
    const dropped = () => {
      this.dropped += 1;
      if (this.armed?.refuseAfterDrop) this.refusing = true;
      this.armed = null;
    };

    // Classifies one executed statement and decides whether to drop.
    // Returns 'forward', 'drop' (before-forward), or 'ack' (after-ack).
    const executed = (
      sql: string,
      protocol: 'simple' | 'extended',
    ): 'forward' | 'drop' | 'ack' => {
      const kind = controlKind(sql);
      this.transcript.push({ connection, protocol, kind });
      if (kind === 'BEGIN') transaction = [];
      if (kind === 'OTHER') transaction.push(sql);
      if (kind !== 'COMMIT') return 'forward';
      const statements = transaction;
      transaction = [];
      const armed = this.armed;
      if (
        !armed ||
        (armed.within &&
          !statements.some((statement) => armed.within!.test(statement)))
      )
        return 'forward';
      armed.remaining -= 1;
      if (armed.remaining > 0) return 'forward';
      return armed.mode === 'before-forward' ? 'drop' : 'ack';
    };

    client.on('data', (chunk: Buffer) => {
      for (const message of fromClient.push(chunk)) {
        if (closed) return;
        let decision: 'forward' | 'drop' | 'ack' = 'forward';
        if (message.type === 'Q') {
          decision = executed(sqlOf('Q', message.bytes) ?? '', 'simple');
        } else if (message.type === 'P') {
          const fields = cstrings(message.bytes.subarray(5), 2);
          if (fields) prepared.set(fields[0], fields[1]);
        } else if (message.type === 'B') {
          // Bind: portal name, then statement name.
          const fields = cstrings(message.bytes.subarray(5), 2);
          const sql = fields ? prepared.get(fields[1]) : undefined;
          if (sql !== undefined) decision = executed(sql, 'extended');
        }
        if (decision === 'drop') {
          dropped();
          cut();
          return;
        }
        if (decision === 'ack') awaitingAck = true;
        upstream.write(message.bytes);
      }
    });

    upstream.on('data', (chunk: Buffer) => {
      if (closed) return;
      // Until the startup message is sent, the server only answers the
      // SSL or GSS request with a single byte; pass it through.
      if (!fromServer.typed) {
        client.write(chunk);
        return;
      }
      for (const message of fromServer.push(chunk)) {
        if (awaitingAck && (message.type === 'C' || message.type === 'E')) {
          // The server has answered the COMMIT: cut the client off before
          // it can read the answer.
          dropped();
          cut();
          return;
        }
        client.write(message.bytes);
      }
    });

    client.on('error', cut);
    upstream.on('error', cut);
    client.on('close', cut);
    upstream.on('close', cut);
  }
}
