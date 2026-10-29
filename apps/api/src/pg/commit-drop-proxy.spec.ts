import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CommitDropProxy, controlKind } from './commit-drop-proxy';

// The commit-dropping proxy against a fake protocol server on loopback.
// No database is involved. The fake speaks both protocols: simple 'Q', and
// extended 'P' (Parse) / 'B' (Bind) / 'E' (Execute) / 'S' (Sync). It records
// each statement when it is executed (Q, or B of a prepared statement).

const int32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
};
const int16 = (value: number) => {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value);
  return buffer;
};
const typed = (type: string, body: Buffer) =>
  Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
const cstring = (text: string) =>
  Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]);
const startup = () => {
  const body = Buffer.concat([
    int32(196608),
    cstring('user'),
    cstring('gate'),
    Buffer.from([0]),
  ]);
  return Buffer.concat([int32(body.length + 4), body]);
};
const sslRequest = () => Buffer.concat([int32(8), int32(80877103)]);
const query = (sql: string) => typed('Q', cstring(sql));
const parse = (name: string, sql: string) =>
  typed('P', Buffer.concat([cstring(name), cstring(sql), int16(0)]));
const bind = (statement: string) =>
  typed(
    'B',
    Buffer.concat([
      cstring(''),
      cstring(statement),
      int16(0),
      int16(0),
      int16(0),
    ]),
  );
const execute = () => typed('E', Buffer.concat([cstring(''), int32(0)]));
const sync = () => typed('S', Buffer.alloc(0));
// One extended-protocol execution of a prepared statement.
const run = (statement: string) =>
  Buffer.concat([bind(statement), execute(), sync()]);
const ready = () => typed('Z', Buffer.from('I'));
const complete = (tag: string) => typed('C', cstring(tag));

type FakeServer = {
  port: number;
  executed: string[];
  ended: Promise<void>;
  close: () => Promise<void>;
};

async function fakeServer(): Promise<FakeServer> {
  const executed: string[] = [];
  let ended!: () => void;
  const endedPromise = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let started = false;
    const statements = new Map<string, string>();
    let bound = '';
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          if (buffer.length < 8) return;
          const length = buffer.readInt32BE(0);
          const code = buffer.readInt32BE(4);
          buffer = buffer.subarray(length);
          if (code === 80877103) socket.write('N');
          else {
            started = true;
            socket.write(ready());
          }
          continue;
        }
        if (buffer.length < 5) return;
        const length = buffer.readInt32BE(1);
        if (buffer.length < 1 + length) return;
        const type = String.fromCharCode(buffer[0]);
        const body = buffer.subarray(5, 1 + length);
        buffer = buffer.subarray(1 + length);
        const strings = body.toString('utf8').split('\0');
        if (type === 'Q') {
          executed.push(strings[0]);
          socket.write(
            Buffer.concat([complete(strings[0].split(' ')[0]), ready()]),
          );
        } else if (type === 'P') {
          statements.set(strings[0], strings[1]);
          socket.write(typed('1', Buffer.alloc(0)));
        } else if (type === 'B') {
          bound = statements.get(strings[1]) ?? '';
          executed.push(bound);
          socket.write(typed('2', Buffer.alloc(0)));
        } else if (type === 'E') {
          socket.write(complete(bound.split(' ')[0]));
        } else if (type === 'S') {
          socket.write(ready());
        }
      }
    });
    socket.on('close', () => ended());
    socket.on('error', () => ended());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    executed,
    ended: endedPromise,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// A raw client: sends bytes, collects everything the proxy forwards.
async function client(port: number) {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  let received = Buffer.alloc(0);
  const closed = new Promise<void>((resolve) => {
    socket.on('close', () => resolve());
    socket.on('error', () => resolve());
  });
  socket.on('data', (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
  });
  return {
    send: (bytes: Buffer) => socket.write(bytes),
    received: () => received,
    closed,
    destroy: () => {
      socket.destroy();
    },
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const server = await fakeServer();
  const proxy = await CommitDropProxy.start({
    host: '127.0.0.1',
    port: server.port,
  });
  cleanups.push(
    () => server.close(),
    () => proxy.close(),
  );
  return { server, proxy };
}

async function connected(proxy: CommitDropProxy) {
  const c = await client(proxy.port);
  cleanups.push(() => c.destroy());
  c.send(startup());
  return c;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('CommitDropProxy (loopback, fake protocol server, no database)', () => {
  it('passes a whole session through when not armed, including SSL negotiation', async () => {
    const { server, proxy } = await setup();
    const c = await client(proxy.port);
    cleanups.push(() => c.destroy());
    c.send(sslRequest());
    await settle();
    expect(c.received().toString('latin1')).toBe('N');
    c.send(startup());
    c.send(query('BEGIN'));
    c.send(query('COMMIT'));
    await settle();
    expect(server.executed).toEqual(['BEGIN', 'COMMIT']);
    expect(c.received().toString('latin1')).toContain('COMMIT');
    expect(proxy.dropped).toBe(0);
  });

  it('before-forward (simple protocol): the server never receives the COMMIT', async () => {
    const { server, proxy } = await setup();
    proxy.arm('before-forward');
    const c = await connected(proxy);
    c.send(query('BEGIN'));
    await settle();
    c.send(query('COMMIT'));
    await c.closed;
    await server.ended;
    expect(server.executed).toEqual(['BEGIN']);
    expect(proxy.dropped).toBe(1);
  });

  it('after-ack (simple protocol): the server executes the COMMIT, the client never sees its answer', async () => {
    const { server, proxy } = await setup();
    proxy.arm('after-ack');
    const c = await connected(proxy);
    c.send(query('BEGIN'));
    await settle();
    c.send(query('COMMIT'));
    await c.closed;
    expect(server.executed).toEqual(['BEGIN', 'COMMIT']);
    const seen = c.received().toString('latin1');
    expect(seen).toContain('BEGIN');
    expect(seen).not.toContain('COMMIT');
  });

  it('before-forward (extended protocol): a parsed COMMIT is never bound, so never executed', async () => {
    const { server, proxy } = await setup();
    proxy.arm('before-forward');
    const c = await connected(proxy);
    c.send(Buffer.concat([parse('', 'BEGIN'), run('')]));
    await settle();
    c.send(Buffer.concat([parse('', 'COMMIT'), run('')]));
    await c.closed;
    expect(server.executed).toEqual(['BEGIN']);
  });

  it('after-ack (extended protocol): cuts the client at the COMMIT’s CommandComplete', async () => {
    const { server, proxy } = await setup();
    proxy.arm('after-ack');
    const c = await connected(proxy);
    c.send(Buffer.concat([parse('', 'BEGIN'), run('')]));
    await settle();
    const before = c.received().length;
    c.send(Buffer.concat([parse('', 'COMMIT'), run('')]));
    await c.closed;
    expect(server.executed).toEqual(['BEGIN', 'COMMIT']);
    expect(c.received().subarray(before).toString('latin1')).not.toContain(
      'COMMIT',
    );
  });

  it('counts a cached prepared COMMIT each time it is bound, and an unnamed one once', async () => {
    const { server, proxy } = await setup();
    proxy.arm('before-forward', { nth: 3 });
    const c = await connected(proxy);
    // Unnamed: parsed and bound once, counted once.
    c.send(Buffer.concat([parse('', 'COMMIT'), run('')]));
    // Named and cached: parsed once, bound twice.
    c.send(Buffer.concat([parse('commit_stmt', 'COMMIT'), run('commit_stmt')]));
    await settle();
    expect(proxy.controlKinds()).toEqual(['COMMIT', 'COMMIT']);
    c.send(run('commit_stmt'));
    await c.closed;
    expect(server.executed).toEqual(['COMMIT', 'COMMIT']);
    expect(proxy.dropped).toBe(1);
  });

  it('arms by transaction content: only the COMMIT of a transaction that ran a matching statement', async () => {
    const { server, proxy } = await setup();
    proxy.arm('before-forward', { within: /INSERT INTO "target"/ });
    const c = await connected(proxy);
    c.send(query('BEGIN'));
    c.send(query('UPDATE "other" SET x = 1'));
    c.send(query('COMMIT'));
    await settle();
    expect(proxy.dropped).toBe(0);
    c.send(query('BEGIN'));
    c.send(
      Buffer.concat([parse('', 'INSERT INTO "target" VALUES ($1)'), run('')]),
    );
    await settle();
    c.send(query('COMMIT'));
    await c.closed;
    expect(server.executed).toEqual([
      'BEGIN',
      'UPDATE "other" SET x = 1',
      'COMMIT',
      'BEGIN',
      'INSERT INTO "target" VALUES ($1)',
    ]);
    expect(proxy.dropped).toBe(1);
  });

  it('records transaction-control kinds only, so a gate can calibrate its assumptions', async () => {
    const { proxy } = await setup();
    const c = await connected(proxy);
    // An autocommitted statement: no transaction control.
    c.send(Buffer.concat([parse('', 'SELECT 1'), run('')]));
    await settle();
    expect(proxy.controlKinds()).toEqual([]);
    proxy.clearTranscript();
    c.send(query('BEGIN'));
    c.send(query('SELECT 1'));
    c.send(query('ROLLBACK'));
    await settle();
    expect(proxy.controlKinds()).toEqual(['BEGIN', 'ROLLBACK']);
    expect(proxy.transcript.every((entry) => entry.connection === 1)).toBe(
      true,
    );
    expect(JSON.stringify(proxy.transcript)).not.toContain('SELECT');
  });

  it('classifies statements by their leading keyword only', () => {
    expect(controlKind('  begin')).toBe('BEGIN');
    expect(
      controlKind('START TRANSACTION ISOLATION LEVEL READ COMMITTED'),
    ).toBe('BEGIN');
    expect(controlKind('COMMIT')).toBe('COMMIT');
    expect(controlKind('END')).toBe('COMMIT');
    expect(controlKind('ROLLBACK')).toBe('ROLLBACK');
    expect(controlKind("SELECT 'COMMIT'")).toBe('OTHER');
    expect(controlKind('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')).toBe(
      'OTHER',
    );
  });

  it('drops only the nth COMMIT, and can refuse connections afterwards', async () => {
    const { server, proxy } = await setup();
    proxy.arm('before-forward', { nth: 2, refuseAfterDrop: true });
    const c = await connected(proxy);
    c.send(query('COMMIT'));
    await settle();
    c.send(query('COMMIT'));
    await c.closed;
    expect(server.executed).toEqual(['COMMIT']);
    const next = await client(proxy.port);
    await next.closed;
    expect(next.received().length).toBe(0);
    proxy.refuse(false);
  });

  it('refuses a non-loopback target and rewrites URLs to itself without TLS', async () => {
    await expect(
      CommitDropProxy.start({ host: '10.0.0.5', port: 55432 }),
    ).rejects.toThrow(/127\.0\.0\.1/);
    const { proxy } = await setup();
    const url = new URL(
      proxy.url(
        'postgresql://gate@127.0.0.1:55432/adflow_gates_test?schema=g1',
      ),
    );
    expect(url.port).toBe(String(proxy.port));
    expect(url.pathname).toBe('/adflow_gates_test');
    expect(url.searchParams.get('sslmode')).toBe('disable');
    expect(url.searchParams.get('schema')).toBe('g1');
  });
});
