import { describe, expect, it } from 'vitest';

import { CapturedCall, callIdOf, isBlocked, parseBody } from '../../../src/helper/capture.js';

describe('Responses tool-call items', () => {
  it('003 FR-009 a call_id that is null is not given: the item id stands for it', () => {
    expect(callIdOf({ type: 'function_call', call_id: null, id: 'fc_1' })).toBe('fc_1');
    expect(callIdOf({ type: 'function_call', call_id: 'call_1', id: 'fc_1' })).toBe('call_1');
    expect(callIdOf({ type: 'mcp_approval_request', id: 'mcpr_1' })).toBe('mcpr_1');
  });

  it('003 FR-009 a result pairs with a call whose call_id is null through the item id', () => {
    const call = { type: 'function_call', call_id: null, id: 'fc_1', name: 'lookup' };
    const answered = parseBody('responses', {
      status: 'completed',
      output: [call, { type: 'function_call_output', call_id: 'fc_1', output: '{}' }],
    });
    expect(answered.choices[0]?.toolEnd).toBe(false);
    const open = parseBody('responses', {
      status: 'completed',
      output: [call, { type: 'function_call_output', call_id: 'other', output: '{}' }],
    });
    expect(open.choices[0]?.toolEnd).toBe(true);
    expect(open.choices[0]?.toolCalls.map((item) => item.id)).toEqual(['fc_1']);
  });

  it('003 FR-009 a null call_id of a result does not fall back to its own id', () => {
    const call = { type: 'function_call', call_id: null, id: 'fc_1', name: 'lookup' };
    const alone = parseBody('responses', { status: 'completed', output: [call] });
    expect(alone.choices[0]?.toolCalls).toHaveLength(1);
    const pointed = parseBody('responses', {
      status: 'completed',
      output: [call, { type: 'function_call_output', call_id: 'fc_1' }],
    });
    expect(pointed.choices[0]?.toolCalls).toHaveLength(0);
    const nullPointer = parseBody('responses', {
      status: 'completed',
      output: [call, { type: 'function_call_output', call_id: null, id: 'fc_1' }],
    });
    expect(nullPointer.choices[0]?.toolCalls).toHaveLength(1);
  });

  it('003 FR-009 a call_id of 0 or false is an ID written as canonical JSON', () => {
    expect(callIdOf({ type: 'function_call', call_id: 0, id: 'fc_1' })).toBe('0');
    expect(callIdOf({ type: 'function_call', call_id: false, id: 'fc_1' })).toBe('false');
    expect(callIdOf({ type: 'function_call', call_id: '', id: 'fc_1' })).toBe('fc_1');
    const call = { type: 'function_call', call_id: 0, name: 'lookup' };
    const paired = parseBody('responses', {
      status: 'completed',
      output: [call, { type: 'function_call_output', call_id: 0 }],
    });
    expect(paired.choices[0]?.toolCalls).toHaveLength(0);
  });

  it('003 FR-009 empty IDs never pair', () => {
    const call = { type: 'function_call', call_id: null, name: 'lookup' };
    for (const pointer of [null, '']) {
      const parsed = parseBody('responses', {
        status: 'completed',
        output: [call, { type: 'function_call_output', call_id: pointer }],
      });
      expect(parsed.choices[0]?.toolCalls).toHaveLength(1);
    }
    const emptyCall = { type: 'function_call', call_id: '', id: '', name: 'lookup' };
    const parsed = parseBody('responses', {
      status: 'completed',
      output: [emptyCall, { type: 'function_call_output', call_id: '' }],
    });
    expect(parsed.choices[0]?.toolCalls).toHaveLength(1);
  });
});

describe('cut calls', () => {
  it('003 FR-023 a request cut on cancel aborts with a reason marked for L3', () => {
    const call = new CapturedCall('chat-completions', { model: 'model-b' }, 0);
    call.cutNow();
    expect(call.cut).toBe(true);
    expect(call.cutter.signal.aborted).toBe(true);
    const reason: unknown = call.cutter.signal.reason;
    expect(isBlocked(reason)).toBe(true);
    // An SDK that wraps the transport error keeps the mark through `cause`.
    expect(isBlocked(new Error('Connection error.', { cause: reason }))).toBe(true);
    expect(isBlocked(new Error('Request timed out.'))).toBe(false);
  });
});
