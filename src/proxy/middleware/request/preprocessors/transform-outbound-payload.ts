import { Request } from "express";
import { z } from "zod";
import { config } from "../../../../config";
import { isTextGenerationRequest, isImageGenerationRequest } from "../../common";
import { RequestPreprocessor } from "../index";
import { APIFormat } from "../../../../shared/key-management";

const CLAUDE_OUTPUT_MAX = config.maxOutputTokensAnthropic;
const OPENAI_OUTPUT_MAX = config.maxOutputTokensOpenAI;

// TODO: move schemas to shared

// https://console.anthropic.com/docs/api/reference#-v1-complete
export const AnthropicV1CompleteSchema = z.object({
  model: z.string(),
  prompt: z.string({
    required_error:
      "No prompt found. Are you sending an OpenAI-formatted request to the Claude endpoint?",
  }),
  max_tokens_to_sample: z.coerce
    .number()
    .int()
    .transform((v) => Math.min(v, CLAUDE_OUTPUT_MAX)),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional().default(false),
  temperature: z.coerce.number().optional().default(1),
  top_k: z.coerce.number().optional(),
  top_p: z.coerce.number().optional(),
  metadata: z.any().optional(),
});

// https://platform.openai.com/docs/api-reference/chat/create
const OpenAIV1ChatContentArraySchema = z.array(
  z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({
      type: z.literal("image_url"),
      image_url: z.object({
        url: z.string().url(),
        detail: z.enum(["low", "auto", "high"]).optional().default("auto"),
      }),
    }),
  ])
);

export const OpenAIV1ChatCompletionSchema = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.union([z.string(), OpenAIV1ChatContentArraySchema]),
      name: z.string().optional(),
    }),
    {
      required_error:
        "No `messages` found. Ensure you've set the correct completion endpoint.",
      invalid_type_error:
        "Messages were not formatted correctly. Refer to the OpenAI Chat API documentation for more information.",
    }
  ),
  temperature: z.number().optional().default(1),
  top_p: z.number().optional().default(1),
  n: z
    .literal(1, {
      errorMap: () => ({
        message: "You may only request a single completion at a time.",
      }),
    })
    .optional(),
  stream: z.boolean().optional().default(false),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  max_tokens: z.coerce
    .number()
    .int()
    .nullish()
    .default(16)
    .transform((v) => Math.min(v ?? OPENAI_OUTPUT_MAX, OPENAI_OUTPUT_MAX)),
  frequency_penalty: z.number().optional().default(0),
  presence_penalty: z.number().optional().default(0),
  logit_bias: z.any().optional(),
  user: z.string().optional(),
  seed: z.number().int().optional(),
});

export type OpenAIChatMessage = z.infer<
  typeof OpenAIV1ChatCompletionSchema
>["messages"][0];

const OpenAIV1TextCompletionSchema = z
  .object({
    model: z
      .string()
      .regex(
        /^gpt-3.5-turbo-instruct/,
        "Model must start with 'gpt-3.5-turbo-instruct'"
      ),
    prompt: z.string({
      required_error:
        "No `prompt` found. Ensure you've set the correct completion endpoint.",
    }),
    logprobs: z.number().int().nullish().default(null),
    echo: z.boolean().optional().default(false),
    best_of: z.literal(1).optional(),
    stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
    suffix: z.string().optional(),
  })
  .merge(OpenAIV1ChatCompletionSchema.omit({ messages: true }));

// https://platform.openai.com/docs/api-reference/images/create
const OpenAIV1ImagesGenerationSchema = z.object({
  prompt: z.string().max(4000),
  model: z.string().optional(),
  quality: z.enum(["standard", "hd"]).optional().default("standard"),
  n: z.number().int().min(1).max(4).optional().default(1),
  response_format: z.enum(["url", "b64_json"]).optional(),
  size: z
    .enum(["256x256", "512x512", "1024x1024", "1792x1024", "1024x1792"])
    .optional()
    .default("1024x1024"),
  style: z.enum(["vivid", "natural"]).optional().default("vivid"),
  user: z.string().optional(),
});

// https://developers.generativeai.google/api/rest/generativelanguage/models/generateText
const PalmV1GenerateTextSchema = z.object({
  model: z.string(),
  prompt: z.object({ text: z.string() }),
  temperature: z.number().optional(),
  maxOutputTokens: z.coerce
    .number()
    .int()
    .optional()
    .default(16)
    .transform((v) => Math.min(v, 1024)), // TODO: Add config
  candidateCount: z.literal(1).optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  safetySettings: z.array(z.object({})).max(0).optional(),
  stopSequences: z.array(z.string()).max(5).optional(),
});

const VALIDATORS: Record<APIFormat, z.ZodSchema<any>> = {
  anthropic: AnthropicV1CompleteSchema,
  openai: OpenAIV1ChatCompletionSchema,
  "openai-text": OpenAIV1TextCompletionSchema,
  "openai-image": OpenAIV1ImagesGenerationSchema,
  "google-palm": PalmV1GenerateTextSchema,
};

/** Transforms an incoming request body to one that matches the target API. */
export const transformOutboundPayload: RequestPreprocessor = async (req) => {
  const sameService = req.inboundApi === req.outboundApi;
  const alreadyTransformed = req.retryCount > 0;
  const notTransformable =
    !isTextGenerationRequest(req) && !isImageGenerationRequest(req);

  if (alreadyTransformed || notTransformable) return;

  if (sameService) {
    const result = VALIDATORS[req.inboundApi].safeParse(req.body);
    if (!result.success) {
      req.log.error(
        { issues: result.error.issues, body: req.body },
        "Request validation failed"
      );
      throw result.error;
    }
    req.body = result.data;
    return;
  }

  if (req.inboundApi === "openai" && req.outboundApi === "anthropic") {
    req.body = openaiToAnthropic(req);
    return;
  }

  if (req.inboundApi === "openai" && req.outboundApi === "google-palm") {
    req.body = openaiToPalm(req);
    return;
  }

  if (req.inboundApi === "openai" && req.outboundApi === "openai-text") {
    req.body = openaiToOpenaiText(req);
    return;
  }

  if (req.inboundApi === "openai" && req.outboundApi === "openai-image") {
    req.body = openaiToOpenaiImage(req);
    return;
  }

  throw new Error(
    `'${req.inboundApi}' -> '${req.outboundApi}' request proxying is not supported. Make sure your client is configured to use the correct API.`
  );
};

function openaiToAnthropic(req: Request) {
  const { body } = req;
  const result = OpenAIV1ChatCompletionSchema.safeParse(body);
  if (!result.success) {
    req.log.warn(
      { issues: result.error.issues, body },
      "Invalid OpenAI-to-Anthropic request"
    );
    throw result.error;
  }

  req.headers["anthropic-version"] = "2023-06-01";

  const { messages, ...rest } = result.data;
  const prompt = openAIMessagesToClaudePrompt(messages);

  let stops = rest.stop
    ? Array.isArray(rest.stop)
      ? rest.stop
      : [rest.stop]
    : [];
  // Recommended by Anthropic
  stops.push("\n\nHuman:");
  // Helps with jailbreak prompts that send fake system messages and multi-bot
  // chats that prefix bot messages with "System: Respond as <bot name>".
  stops.push("\n\nSystem:");
  // Remove duplicates
  stops = [...new Set(stops)];

  return {
    // Model may be overridden in `calculate-context-size.ts` to avoid having
    // a circular dependency (`calculate-context-size.ts` needs an already-
    // transformed request body to count tokens, but this function would like
    // to know the count to select a model).
    model: process.env.CLAUDE_SMALL_MODEL || "claude-v1",
    prompt: prompt,
    max_tokens_to_sample: rest.max_tokens,
    stop_sequences: stops,
    stream: rest.stream,
    temperature: rest.temperature,
    top_p: rest.top_p,
  };
}

function openaiToOpenaiText(req: Request) {
  const { body } = req;
  const result = OpenAIV1ChatCompletionSchema.safeParse(body);
  if (!result.success) {
    req.log.warn(
      { issues: result.error.issues, body },
      "Invalid OpenAI-to-OpenAI-text request"
    );
    throw result.error;
  }

  const { messages, ...rest } = result.data;
  const prompt = flattenOpenAIChatMessages(messages);

  let stops = rest.stop
    ? Array.isArray(rest.stop)
      ? rest.stop
      : [rest.stop]
    : [];
  stops.push("\n\nUser:");
  stops = [...new Set(stops)];

  const transformed = { ...rest, prompt: prompt, stop: stops };
  return OpenAIV1TextCompletionSchema.parse(transformed);
}

// Takes the last chat message and uses it verbatim as the image prompt.
function openaiToOpenaiImage(req: Request) {
  const { body } = req;
  const result = OpenAIV1ChatCompletionSchema.safeParse(body);
  if (!result.success) {
    req.log.warn(
      { issues: result.error.issues, body },
      "Invalid OpenAI-to-OpenAI-image request"
    );
    throw result.error;
  }

  const { messages } = result.data;
  const prompt = messages.filter((m) => m.role === "user").pop()?.content;
  if (Array.isArray(prompt)) {
    throw new Error("Image generation prompt must be a text message.");
  }

  if (body.stream) {
    throw new Error(
      "Streaming is not supported for image generation requests."
    );
  }

  // Some frontends do weird things with the prompt, like prefixing it with a
  // character name or wrapping the entire thing in quotes. We will look for
  // the index of "Image:" and use everything after that as the prompt.

  const index = prompt?.toLowerCase().indexOf("image:");
  if (index === -1 || !prompt) {
    throw new Error(
      `Start your prompt with 'Image:' followed by a description of the image you want to generate (received: ${prompt}).`
    );
  }

  // TODO: Add some way to specify parameters via chat message
  const transformed = {
    model: body.model.includes("dall-e") ? body.model : "dall-e-3",
    quality: "standard",
    size: "1024x1024",
    response_format: "url",
    prompt: prompt.slice(index! + 6).trim(),
  };
  return OpenAIV1ImagesGenerationSchema.parse(transformed);
}

function openaiToPalm(req: Request): z.infer<typeof PalmV1GenerateTextSchema> {
  const { body } = req;
  const result = OpenAIV1ChatCompletionSchema.safeParse({
    ...body,
    model: "gpt-3.5-turbo",
  });
  if (!result.success) {
    req.log.warn(
      { issues: result.error.issues, body },
      "Invalid OpenAI-to-Palm request"
    );
    throw result.error;
  }

  const { messages, ...rest } = result.data;
  const prompt = flattenOpenAIChatMessages(messages);

  let stops = rest.stop
    ? Array.isArray(rest.stop)
      ? rest.stop
      : [rest.stop]
    : [];

  stops.push("\n\nUser:");
  stops = [...new Set(stops)];

  z.array(z.string()).max(5).parse(stops);

  return {
    prompt: { text: prompt },
    maxOutputTokens: rest.max_tokens,
    stopSequences: stops,
    model: "text-bison-001",
    topP: rest.top_p,
    temperature: rest.temperature,
    safetySettings: [
      { category: "HARM_CATEGORY_UNSPECIFIED", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DEROGATORY", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_TOXICITY", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_VIOLENCE", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUAL", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_MEDICAL", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS", threshold: "BLOCK_NONE" },
    ],
  };
}

export function openAIMessagesToClaudePrompt(messages: OpenAIChatMessage[]) {
  return (
    messages
      .map((m) => {
        let role: string = m.role;
        if (role === "assistant") {
          role = "Assistant";
        } else if (role === "system") {
          role = "System";
        } else if (role === "user") {
          role = "Human";
        }
        const name = m.name?.trim();
        const content = flattenOpenAIMessageContent(m.content);
        // https://console.anthropic.com/docs/prompt-design
        // `name` isn't supported by Anthropic but we can still try to use it.
        return `\n\n${role}: ${name ? `(as ${name}) ` : ""}${content}`;
      })
      .join("") + "\n\nAssistant:"
  );
}

function flattenOpenAIChatMessages(messages: OpenAIChatMessage[]) {
  // Temporary to allow experimenting with prompt strategies
  const PROMPT_VERSION: number = 1;
  switch (PROMPT_VERSION) {
    case 1:
      return (
        messages
          .map((m) => {
            // Claude-style human/assistant turns
            let role: string = m.role;
            if (role === "assistant") {
              role = "Assistant";
            } else if (role === "system") {
              role = "System";
            } else if (role === "user") {
              role = "User";
            }
            return `\n\n${role}: ${flattenOpenAIMessageContent(m.content)}`;
          })
          .join("") + "\n\nAssistant:"
      );
    case 2:
      return messages
        .map((m) => {
          // Claude without prefixes (except system) and no Assistant priming
          let role: string = "";
          if (role === "system") {
            role = "System: ";
          }
          return `\n\n${role}${flattenOpenAIMessageContent(m.content)}`;
        })
        .join("");
    default:
      throw new Error(`Unknown prompt version: ${PROMPT_VERSION}`);
  }
}

function flattenOpenAIMessageContent(
  content: OpenAIChatMessage["content"]
): string {
  return Array.isArray(content)
    ? content
        .map((contentItem) => {
          if ("text" in contentItem) return contentItem.text;
          if ("image_url" in contentItem) return "[ Uploaded Image Omitted ]";
        })
        .join("\n")
    : content;
}
