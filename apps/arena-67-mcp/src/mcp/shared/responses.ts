import axios from 'axios';

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function toolSuccess(value: unknown) {
  return { content: [{ type: 'text' as const, text: jsonText(value) }] };
}

/**
 * Turns a failure into something the model can act on.
 *
 * A connection refused and a 404 mean different things to a caller — one is
 * "the desk is down, stop trying", the other is "that thing does not exist,
 * tell the user" — so they are not flattened into one message.
 */
function toolError(error: unknown) {
  let message = 'The Arena 67 backend request failed.';

  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNREFUSED') {
      message =
        'The Arena 67 backend is not reachable. It should be running on :9000.';
    } else {
      const data = error.response?.data as
        | { message?: string | string[]; error?: string }
        | undefined;
      const detail = Array.isArray(data?.message)
        ? data?.message.join('; ')
        : data?.message;
      message = detail ?? data?.error ?? error.message ?? message;
    }
  } else if (error instanceof Error) {
    message = error.message;
  }

  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function resourceContents(uri: URL, value: unknown) {
  return {
    contents: [
      { uri: uri.href, mimeType: 'application/json', text: jsonText(value) },
    ],
  };
}

export { resourceContents, toolError, toolSuccess };
