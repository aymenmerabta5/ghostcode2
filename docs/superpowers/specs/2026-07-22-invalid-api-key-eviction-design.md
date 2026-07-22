# Invalid API Key Pool Eviction Design

## Goal

Remove an API key from its provider rotation pool when inference returns the structured OpenAI-compatible error code `invalid_api_key`.

## Root Cause

`SessionRetry.retryable` only labels billing-verification failures as `isInvalid`. The retry policy already maps `isInvalid` to `onInvalidKey`, which removes the selected key through `Provider.removeKey`. The rotator safely removes the matching key by identity and persists the remaining pool to `providers/<providerID>/apiKeys.json`.

The response below therefore does not currently trigger removal because its nested error code is not recognized:

```json
{"error":{"code":"invalid_api_key","message":"Unauthorized","param":null,"type":"authentication_error"}}
```

## Design

Add a narrow structured check in `packages/opencode/src/session/retry.ts`: when decoded JSON has `error.code === "invalid_api_key"`, return a retry classification with `isInvalid: true`. Preserve the server-provided message when available.

No rotation or persistence changes are required. The existing policy invokes `onInvalidKey`, and the existing provider/key-rotator path removes the selected key permanently and safely under concurrent failures.

## Testing

Add a focused `retryable` regression test using the exact error payload. It will assert the parsed error is invalid, proving the policy will use its established key-removal callback rather than a cooldown path.

## Scope

Only the explicit structured `invalid_api_key` code is evicted. Other authentication errors are intentionally left unchanged to avoid permanently removing keys for unrelated authorization or provider-side authentication conditions.
