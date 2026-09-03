import http from 'node:http';
import { once } from 'node:events';

const PRIVATE = Object.freeze({
  successPrompt: 'PRIVATE_SUCCESS_WORKER_PROMPT_7f2c',
  cancelPrompt: 'PRIVATE_CANCEL_WORKER_PROMPT_8a3d',
  failurePrompt: 'PRIVATE_FAILURE_WORKER_PROMPT_9b4e',
  steer: 'PRIVATE_STEERING_TEXT_1c5f',
  message: 'PRIVATE_MESSAGE_DELIVERY_TEXT_2d6a',
  followUp: 'PRIVATE_FOLLOW_UP_TEXT_3e7b',
  rawCommand: 'RAW_COMMAND_PRIVATE_4f8c',
});

function responseFixture(output) {
  return {
    id: 'resp-worker-pty-fixture',
    created_at: 1,
    output_text: '',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: 'deterministic-v1',
    object: 'response',
    output,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    status: 'completed',
    usage: {
      input_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 3,
    },
  };
}

function sendToolCall(response, step, input) {
  const args = JSON.stringify(input);
  const item = {
    type: 'function_call',
    id: `item-root-${step}`,
    call_id: `call-root-${step}`,
    name: 'worker',
    arguments: args,
    status: 'completed',
  };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end([
    `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', delta: args, item_id: item.id, output_index: 0, sequence_number: 1 })}`,
    '',
    `data: ${JSON.stringify({ type: 'response.output_item.done', item, output_index: 0, sequence_number: 2 })}`,
    '',
    `data: ${JSON.stringify({ type: 'response.completed', response: responseFixture([item]), sequence_number: 3 })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n'));
}

function sendMessage(response, text) {
  const item = {
    id: `msg-${text.toLowerCase()}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const added = {
    type: 'response.output_item.added',
    sequence_number: 0,
    output_index: 0,
    item: { ...item, status: 'in_progress', content: [] },
  };
  const delta = {
    type: 'response.output_text.delta',
    sequence_number: 1,
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    delta: text,
    logprobs: [],
  };
  const done = { type: 'response.output_item.done', sequence_number: 2, output_index: 0, item };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end([
    `data: ${JSON.stringify(added)}`,
    '',
    `data: ${JSON.stringify(delta)}`,
    '',
    `data: ${JSON.stringify(done)}`,
    '',
    `data: ${JSON.stringify({ type: 'response.completed', response: responseFixture([item]), sequence_number: 3 })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n'));
}

function workerIds(value) {
  if (typeof value === 'string') {
    try {
      return workerIds(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap(workerIds);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...(key === 'workerId' && typeof item === 'string' ? [item] : []),
    ...workerIds(item),
  ]);
}

function latestWorkerId(input, label) {
  const id = [...new Set(workerIds(input))].at(-1);
  if (id === undefined) throw new Error(`${label} omitted its worker id`);
  return id;
}

function rootCommand(step, input) {
  switch (step) {
    case 0:
      return {
        action: 'spawn',
        task: PRIVATE.successPrompt,
        tools: [],
        model: { providerId: 'fixture', modelId: 'deterministic-v1' },
        maxTurns: 8,
        workspace: { mode: 'shared' },
      };
    case 1:
      return { action: 'steer', workerId: latestWorkerId(input, 'steer'), text: PRIVATE.steer };
    case 2:
      return { action: 'send', workerId: latestWorkerId(input, 'send'), text: `${PRIVATE.message} ${PRIVATE.rawCommand}` };
    case 3:
      return { action: 'follow-up', workerId: latestWorkerId(input, 'follow-up'), text: PRIVATE.followUp };
    case 4:
      return { action: 'wait', workerId: latestWorkerId(input, 'success wait'), timeoutMs: 15_000 };
    case 5:
      return {
        action: 'spawn',
        task: PRIVATE.cancelPrompt,
        tools: [],
        model: { providerId: 'fixture', modelId: 'deterministic-v1' },
        maxTurns: 4,
        workspace: { mode: 'shared' },
      };
    case 6:
      return { action: 'abort', workerId: latestWorkerId(input, 'abort'), reason: 'graceful lifecycle test cancellation' };
    case 7:
      return { action: 'wait', workerId: latestWorkerId(input, 'cancel wait'), timeoutMs: 15_000 };
    case 8:
      return {
        action: 'spawn',
        task: PRIVATE.failurePrompt,
        tools: [],
        model: { providerId: 'fixture', modelId: 'deterministic-v1' },
        maxTurns: 2,
        workspace: { mode: 'shared' },
      };
    case 9:
      return { action: 'wait', workerId: latestWorkerId(input, 'failure wait'), timeoutMs: 15_000 };
    default:
      return undefined;
  }
}

export async function createNativeWorkerLifecycleProvider() {
  const receipts = {
    rootActions: [],
    rootRequests: [],
    rootErrors: [],
    childInputs: [],
    workerIds: new Set(),
    cancelRequestClosed: false,
    failureRequests: 0,
  };
  let rootStep = 0;
  let successStarted = false;
  const heldResponses = new Set();
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      response.writeHead(400).end(error instanceof Error ? error.message : String(error));
      return;
    }
    const input = parsed.input;
    const encoded = JSON.stringify(input);
    if (encoded.includes('ROOT_WORKER_PTY_MATRIX_')) {
      receipts.rootRequests.push({ step: rootStep, workerIds: [...new Set(workerIds(input))].length });
      let command;
      try {
        command = rootCommand(rootStep, input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        receipts.rootErrors.push({ step: rootStep, message });
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message } }));
        return;
      }
      if (command === undefined) {
        sendMessage(response, 'PTY_WORKER_MATRIX_COMPLETE');
        rootStep += 1;
        return;
      }
      receipts.rootActions.push(command.action);
      for (const id of workerIds(input)) receipts.workerIds.add(id);
      if (rootStep === 2 || rootStep === 3) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      sendToolCall(response, rootStep, command);
      rootStep += 1;
      return;
    }
    if (encoded.includes(PRIVATE.cancelPrompt)) {
      receipts.childInputs.push('cancel-started');
      heldResponses.add(response);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.on('close', () => {
        receipts.cancelRequestClosed = true;
        heldResponses.delete(response);
      });
      return;
    }
    if (encoded.includes(PRIVATE.failurePrompt)) {
      receipts.childInputs.push('failure-started');
      receipts.failureRequests += 1;
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'deterministic child provider failure' } }));
      return;
    }
    if (encoded.includes(PRIVATE.successPrompt)) {
      if (!successStarted) {
        successStarted = true;
        receipts.childInputs.push('success-started');
      }
      const phases = [
        { phase: 'steer', index: encoded.lastIndexOf(PRIVATE.steer) },
        { phase: 'message', index: encoded.lastIndexOf(PRIVATE.message) },
        { phase: 'follow-up', index: encoded.lastIndexOf(PRIVATE.followUp) },
      ].filter(({ index }) => index >= 0).sort((left, right) => right.index - left.index);
      if (phases[0] !== undefined) receipts.childInputs.push(phases[0].phase);
      sendMessage(response, 'CHILD_INPUT_ACKNOWLEDGED');
      return;
    }
    response.writeHead(400).end('fixture could not classify model actor');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('worker lifecycle fixture address unavailable');
  return {
    port: address.port,
    privateValues: Object.values(PRIVATE),
    snapshot() {
      return {
        rootActions: [...receipts.rootActions],
        rootRequests: [...receipts.rootRequests],
        rootErrors: [...receipts.rootErrors],
        childInputs: [...receipts.childInputs],
        workerIds: [...receipts.workerIds],
        cancelRequestClosed: receipts.cancelRequestClosed,
        failureRequests: receipts.failureRequests,
      };
    },
    async close() {
      for (const response of heldResponses) response.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}
