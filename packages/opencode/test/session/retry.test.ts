import { expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionRetry } from "@/session/retry"

test("classifies OpenAI invalid API key responses for pool eviction", () => {
  const result = SessionRetry.retryable({
    data: {
      message: JSON.stringify({
        error: {
          code: "invalid_api_key",
          message: "Unauthorized",
          param: null,
          type: "authentication_error",
        },
      }),
    },
  } as never)

  expect(result).toMatchObject({
    message: "Unauthorized",
    isInvalid: true,
  })
})

test("classifies inference invalid API key responses for pool eviction", () => {
  const result = SessionRetry.retryable(
    new SessionV1.APIError({
      message: "Unauthorized",
      statusCode: 401,
      isRetryable: false,
      responseBody: JSON.stringify({
        error: {
          code: "invalid_api_key",
          message: "Unauthorized",
          param: null,
          type: "authentication_error",
        },
      }),
    }).toObject(),
  )

  expect(result).toMatchObject({
    message: "Unauthorized",
    isInvalid: true,
  })
})
