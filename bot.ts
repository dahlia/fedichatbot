import Template from "@deno-library/template";
import {
  type Actor,
  createBot,
  parseSemVer,
  type Session,
} from "@fedify/botkit";
import type { Message, MessageClass } from "@fedify/botkit/message";
import {
  link,
  markdown,
  mention,
  mentions,
  type Text,
  text,
} from "@fedify/botkit/text";
import { getActorHandle } from "@fedify/fedify/vocab";
import { DenoKvMessageQueue, DenoKvStore } from "@fedify/fedify/x/denokv";
import { get, set } from "@kitsonk/kv-toolbox/blob";
import {
  AIMessage,
  HumanMessage,
  type MessageContent,
  SystemMessage,
} from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { configure, getConsoleSink, getLogger } from "@logtape/logtape";
import "@std/dotenv/load";
import { encodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path/join";
import { AsyncLocalStorage } from "node:async_hooks";
import { FilterXSS } from "xss";
import metadata from "./deno.json" with { type: "json" };

await configure({
  sinks: {
    console: getConsoleSink(),
  },
  loggers: [
    {
      category: ["logtape", "meta"],
      lowestLevel: "warning",
      sinks: ["console"],
    },
    { category: "fedichatbot", lowestLevel: "debug", sinks: ["console"] },
    { category: "fedify", lowestLevel: "warning", sinks: ["console"] },
  ],
  contextLocalStorage: new AsyncLocalStorage(),
});

const logger = getLogger("fedichatbot");

const kv = await Deno.openKv();

const bot = createBot<void>({
  username: "FediChatBot",
  name: "FediChatBot",
  summary: text`An LLM-powered chatbot for the fediverse, powered by ${
    link("BotKit", "https://botkit.fedify.dev/")
  } and ${
    link(
      "Gemini 2.0 Flash (experimental)",
      "https://ai.google.dev/gemini-api/docs/models/gemini#gemini-2.0-flash",
    )
  }.`,
  icon: new URL(
    "https://raw.githubusercontent.com/dahlia/fedichatbot/refs/heads/main/logo.png",
  ),
  properties: {
    "Model": link(
      "Gemini 2.0 Flash (experimental)",
      "https://ai.google.dev/gemini-api/docs/models/gemini#gemini-2.0-flash",
    ),
    "Source code": link("GitHub", "https://github.com/dahlia/fedichatbot"),
    "Powered by": link("BotKit", "https://botkit.fedify.dev/"),
    "Created by": mention("@hongminhee@hollo.social"),
  },
  software: {
    name: "fedichatbot",
    version: parseSemVer(metadata.version),
    repository: new URL("https://github.com/dahlia/fedichatbot"),
  },
  kv: new DenoKvStore(kv),
  queue: new DenoKvMessageQueue(kv),
  behindProxy: Deno.env.get("DENO_DEPLOYMENT_ID") == null,
});

bot.onFollow = async (session, actor) => {
  const response = await llm.invoke([
    getSystemMessage(session),
    await getIntroMessage(session, actor, await getFollowPrompt(actor)),
  ]);
  const message = response.content.toString();
  const md: Text<"block", void> = markdown(message);
  await session.publish(
    await mentions(session, md, actor) ? md : text`${mention(actor)}\n\n${md}`,
  );
};

bot.onMention = async (session, msg) => {
  if (msg.replyTarget != null) return;
  const actor = msg.actor;
  const response = await llm.invoke([
    getSystemMessage(session),
    await getIntroMessage(session, actor, await getMentionPrompt(actor)),
    await getHumanMessage(msg),
  ]);
  const message = response.content.toString();
  const md: Text<"block", void> = markdown(message);
  await msg.reply(
    await mentions(session, md, actor) ? md : text`${mention(actor)}\n\n${md}`,
  );
};

bot.onReply = async (session, msg) => {
  const thread: Message<MessageClass, void>[] = [msg];
  for (let m = msg; m.replyTarget != null; m = m.replyTarget) {
    thread.unshift(m.replyTarget);
  }
  const messages: (SystemMessage | HumanMessage | AIMessage)[] = [
    getSystemMessage(session),
    await getIntroMessage(
      session,
      thread[0].actor,
      thread[0].actor?.id?.href === session.actorId.href
        ? await getFollowPrompt(thread[0].actor)
        : await getMentionPrompt(thread[0].actor),
    ),
  ];
  for (const msg of thread) {
    const message = msg.actor?.id?.href === session.actorId.href
      ? new AIMessage(msg.text)
      : await getHumanMessage(msg);
    messages.push(message);
  }
  const response = await llm.invoke(messages);
  const message = response.content.toString();
  const md: Text<"block", void> = markdown(message);
  await msg.reply(
    await mentions(session, md, msg.actor)
      ? md
      : text`${mention(msg.actor)}\n\n${md}`,
  );
};

const llm = new ChatGoogleGenerativeAI({
  model: "gemini-2.0-flash-exp",
  temperature: 0.25,
  maxRetries: 2,
});

const SYSTEM_PROMPT_TEMPLATE = await Deno.readTextFile(
  join(import.meta.dirname!, "prompts", "system.txt"),
);
const FOLLOW_PROMPT_TEMPLATE = await Deno.readTextFile(
  join(import.meta.dirname!, "prompts", "follow.txt"),
);
const MENTION_PROMPT_TEMPLATE = await Deno.readTextFile(
  join(import.meta.dirname!, "prompts", "mention.txt"),
);

const template = new Template({ isEscape: false });

function getSystemPrompt(session: Session<void>): string {
  return template.render(SYSTEM_PROMPT_TEMPLATE, {
    fediverseHandle: session.actorHandle,
    dateTime: new Date().toUTCString(),
  });
}

function getSystemMessage(session: Session<void>): SystemMessage {
  const lg = logger.getChild("prompts");
  const text = getSystemPrompt(session);
  lg.debug("System prompt:\n{text}", { text });
  return new SystemMessage(text);
}

const textXss = new FilterXSS({
  allowList: {},
  stripIgnoreTag: true,
});

async function getFollowPrompt(actor: Actor): Promise<string> {
  let fediverseHandle: string;
  try {
    fediverseHandle = await getActorHandle(actor);
  } catch {
    fediverseHandle = "not available";
  }
  const bio = actor.summary?.toString();
  return template.render(FOLLOW_PROMPT_TEMPLATE, {
    displayName: actor.name?.toString() ?? "not available",
    fediverseHandle,
    quotedBio: bio == null
      ? "Not available."
      : `> ${textXss.process(bio).replaceAll("\n", "\n> ")}`,
  });
}

async function getIntroMessage(
  session: Session<void>,
  actor: Actor,
  prompt: string,
): Promise<HumanMessage> {
  const lg = logger.getChild("prompts");
  const options = {
    contextLoader: session.context.contextLoader,
    documentLoader: await session.context.getDocumentLoader(session.bot),
    suppressError: true,
  };
  lg.debug("Intro prompt:\n{prompt}", { prompt });
  const content: MessageContent = [
    { type: "text", text: prompt },
  ];
  const icon = await actor.getIcon(options);
  if (icon != null && icon.url != null) {
    const url = icon.url instanceof URL ? icon.url : icon.url.href;
    if (url != null) {
      content.push({
        type: "image_url",
        image_url: { url: await toDataUrl(url) },
      });
    }
  }
  const image = await actor.getImage(options);
  if (image != null && image.url != null) {
    const url = image.url instanceof URL ? image.url : image.url.href;
    if (url != null) {
      content.push({
        type: "image_url",
        image_url: { url: await toDataUrl(url) },
      });
    }
  }
  return new HumanMessage({ content });
}

async function getMentionPrompt(actor: Actor): Promise<string> {
  let fediverseHandle: string;
  try {
    fediverseHandle = await getActorHandle(actor);
  } catch {
    fediverseHandle = "not available";
  }
  const bio = actor.summary?.toString();
  return template.render(MENTION_PROMPT_TEMPLATE, {
    displayName: actor.name?.toString() ?? "not available",
    fediverseHandle,
    quotedBio: bio == null
      ? "Not available."
      : `> ${textXss.process(bio).replaceAll("\n", "\n> ")}`,
  });
}

async function getHumanMessage<T extends MessageClass>(
  msg: Message<T, void>,
): Promise<HumanMessage> {
  const attachments = msg.attachments.map(async (doc) => {
    if (!doc.mediaType?.startsWith("image/")) return null;
    const url = doc.url instanceof URL ? doc.url : doc.url?.href;
    if (url == null) return null;
    return {
      type: "image_url",
      image_url: { url: await toDataUrl(url) },
    };
  });
  return new HumanMessage({
    content: [
      { type: "text", text: msg.text },
      ...(await Promise.all(attachments)).filter((a) => a != null),
    ],
  });
}

async function toDataUrl(imageUrl: string | URL): Promise<string> {
  const cached = await get(kv, ["imageCache", imageUrl.toString()]);
  let bytes: ArrayBuffer;
  if (cached.value == null) {
    const response = await fetch(imageUrl);
    const blob = await response.blob();
    bytes = await blob.arrayBuffer();
    await set(kv, ["imageCache", imageUrl.toString()], bytes, {
      expireIn: 1000 * 60 * 60 * 3, // 3 hours
    });
  } else {
    bytes = cached.value;
  }
  return `data:image/jpeg;base64,${encodeBase64(bytes)}`;
}

export default bot;