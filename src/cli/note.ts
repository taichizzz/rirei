import { Command } from 'commander';
import { taskContext } from '../lifecycle.js';
import {
  addHandoffNote,
  importHandoffNotes,
  parseNoteType,
  resolveHandoffNote,
  type NoteImportItem,
} from '../state/notes.js';

const STDIN_MAX_BYTES = 16 * 1024;

function readStdin(maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let oversized = false;
    process.stdin.on('data', (chunk: Buffer) => {
      if (oversized) return;
      total += chunk.length;
      if (total > maxBytes) {
        oversized = true;
        reject(new Error(`Note import payload exceeds ${maxBytes} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => {
      if (!oversized) resolve(Buffer.concat(chunks, total));
    });
    process.stdin.on('error', reject);
  });
}

export function noteCommand(): Command {
  const command = new Command('note')
    .description('Record or resolve a compact task handoff note')
    .argument(
      '<type>',
      'done, next, decision, rejected, blocker, question, or resolve',
    )
    .argument('<text>', 'note text, or the note ID when resolving')
    .option('--reason <reason>', 'short rationale or failure reason')
    .option('--source <source>', 'user or agent', 'user')
    .option('--agent <name>', 'agent that reported the note')
    .option('--json', 'print machine-readable JSON');

  command
    .command('import')
    .description(
      'Atomically import up to 20 validated notes from a JSON payload on stdin',
    )
    .option('--stdin', 'read the JSON payload from standard input')
    .action(async (options: { stdin?: boolean }, importCommand: Command) => {
      if (!options.stdin) throw new Error('Note import requires --stdin.');
      const parent = importCommand.parent as Command | undefined;
      const source = (parent?.opts().source ?? 'user') as string;
      const agent = parent?.opts().agent as string | undefined;
      const payloadText = (await readStdin(STDIN_MAX_BYTES)).toString('utf8');
      let payload: { schemaVersion?: unknown; notes?: unknown };
      try {
        payload = JSON.parse(payloadText) as typeof payload;
      } catch {
        throw new Error('Note import payload must be valid JSON.');
      }
      if (
        typeof payload !== 'object' ||
        payload === null ||
        Object.keys(payload).some(
          (key) => key !== 'schemaVersion' && key !== 'notes',
        )
      )
        throw new Error(
          'Note import payload only accepts schemaVersion and notes fields.',
        );
      if (payload.schemaVersion !== 1)
        throw new Error('Note import requires schemaVersion 1.');
      if (!Array.isArray(payload.notes))
        throw new Error('Note import payload must contain a notes array.');
      const items: NoteImportItem[] = payload.notes.map((entry) => {
        if (typeof entry !== 'object' || entry === null)
          throw new Error('Each imported note must be an object.');
        const note = entry as Record<string, unknown>;
        if (
          Object.keys(note).some(
            (key) => key !== 'type' && key !== 'text' && key !== 'reason',
          )
        )
          throw new Error(
            'Imported notes only accept type, text, and reason fields.',
          );
        if (typeof note.type !== 'string' || typeof note.text !== 'string')
          throw new Error(
            'Each imported note must have string type and text fields.',
          );
        if (note.reason !== undefined && typeof note.reason !== 'string')
          throw new Error('Imported note reasons must be strings.');
        return {
          type: note.type,
          text: note.text,
          reason: note.reason as string | undefined,
        };
      });
      const context = await taskContext();
      const notes = await importHandoffNotes(context.root, context.state, {
        notes: items,
        source:
          source === 'user' || source === 'agent'
            ? source
            : (() => {
                throw new Error('--source must be user or agent.');
              })(),
        agent,
      });
      process.stdout.write(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            notes: notes.map((note) => ({
              id: note.id,
              type: note.type,
              text: note.text,
              provenance: note.provenance,
              git: note.git,
            })),
          },
          null,
          2,
        )}\n`,
      );
    });

  command.action(
    async (
      type: string,
      text: string,
      options: {
        reason?: string;
        source: string;
        agent?: string;
        json?: boolean;
      },
    ) => {
      const context = await taskContext();
      const note =
        type === 'resolve'
          ? await resolveHandoffNote(context.root, context.state, text)
          : await addHandoffNote(context.root, context.state, {
              type: parseNoteType(type),
              text,
              reason: options.reason,
              source:
                options.source === 'user' || options.source === 'agent'
                  ? options.source
                  : (() => {
                      throw new Error('--source must be user or agent.');
                    })(),
              agent: options.agent,
            });
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ schemaVersion: 1, note }, null, 2)}\n`,
        );
        return;
      }
      process.stdout.write(
        type === 'resolve'
          ? `Resolved Relay note ${note.id}\n`
          : `Recorded ${note.type} note ${note.id}\n`,
      );
    },
  );

  return command;
}
