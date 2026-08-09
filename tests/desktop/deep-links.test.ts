import { describe, expect, test, vi } from 'vitest';
import {
  DeepLinkIntentQueue,
  parseTerminalDeepLink,
  terminalDeepLinksFromArgv,
  terminalOwnerWebContentsId,
} from '../../desktop/deep-links.mjs';

const id = '123e4567-e89b-12d3-a456-426614174000';

describe('desktop deep links', () => {
  test('parses only an exact terminal UUID URL', () => {
    expect(parseTerminalDeepLink(`rirei://terminal/${id}`)).toEqual({
      terminalId: id,
    });
    expect(
      parseTerminalDeepLink(`rirei://terminal/${id.toUpperCase()}`),
    ).toEqual({ terminalId: id });
  });

  test.each([
    'rirei://terminal/',
    'rirei://terminal/not-a-uuid',
    `rirei://user@terminal/${id}`,
    `rirei://terminal:443/${id}`,
    `rirei://terminal/${id}?select=true`,
    `rirei://terminal/${id}#terminal`,
    `rirei://terminal/nested/${id}`,
    `rirei://terminal/%2F${id}`,
    `rirei://terminal/%5C${id}`,
    `rirei://terminal/${id}%2Fother`,
    ` rirei://terminal/${id}`,
  ])('rejects %s', (value) => {
    expect(parseTerminalDeepLink(value)).toBeNull();
  });

  test('extracts valid links from process arguments', () => {
    expect(
      terminalDeepLinksFromArgv([
        'electron',
        '.',
        'invalid',
        `rirei://terminal/${id}`,
      ]),
    ).toEqual([{ terminalId: id }]);
  });

  test('looks up terminal ownership only from the main-process inventory', () => {
    const terminals = new Map([
      [id, { ownerWebContentsId: 42 }],
      ['invalid-owner', { ownerWebContentsId: '42' }],
    ]);
    expect(terminalOwnerWebContentsId(terminals, id)).toBe(42);
    expect(terminalOwnerWebContentsId(terminals, 'missing')).toBeNull();
    expect(terminalOwnerWebContentsId(terminals, 'invalid-owner')).toBeNull();
  });

  test('keeps intents queued until delivery is ready', () => {
    const queue = new DeepLinkIntentQueue();
    const deliver = vi.fn(() => false);
    const intent = { terminalId: id };
    queue.enqueue(intent);

    queue.flush(deliver);
    expect(queue.size).toBe(1);

    deliver.mockReturnValue(true);
    queue.flush(deliver);
    expect(queue.size).toBe(0);
    expect(deliver).toHaveBeenCalledWith(intent);
  });

  test('retains an intent when delivery throws', () => {
    const queue = new DeepLinkIntentQueue();
    queue.enqueue({ terminalId: id });
    queue.flush(() => {
      throw new Error('window reloading');
    });
    expect(queue.size).toBe(1);
  });

  test('bounds and deduplicates externally supplied intents', () => {
    const queue = new DeepLinkIntentQueue(2);
    queue.enqueue({ terminalId: 'first' });
    queue.enqueue({ terminalId: 'second' });
    queue.enqueue({ terminalId: 'second' });
    queue.enqueue({ terminalId: 'third' });
    const delivered = [];
    queue.flush((intent) => {
      delivered.push(intent.terminalId);
      return true;
    });
    expect(delivered).toEqual(['second', 'third']);
  });
});
