import { z } from "zod";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { accountsRecord, retrievableAccountsRecord } from "./account-keys.js";
import {
  normalizeTelegramCommandDescription,
  normalizeTelegramCommandName,
  resolveTelegramCustomCommands,
} from "./telegram-custom-commands.js";
import { ToolPolicySchema } from "./zod-schema.agent-runtime.js";
import { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";
import {
  BlockStreamingChunkSchema,
  BlockStreamingCoalesceSchema,
  DmConfigSchema,
  DmPolicySchema,
  ExecutableTokenSchema,
  GroupPolicySchema,
  HexColorSchema,
  MarkdownConfigSchema,
  MSTeamsReplyStyleSchema,
  ProviderCommandsSchema,
  ReplyToModeSchema,
  RetryConfigSchema,
  requireOpenAllowFrom,
} from "./zod-schema.core.js";
import { sensitive } from "./zod-schema.sensitive.js";

const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

const DiscordIdSchema = z
  .union([z.string(), z.number()])
  .refine((value) => typeof value === "string", {
    message: "Discord IDs must be strings (wrap numeric IDs in quotes).",
  });
const DiscordIdListSchema = z.array(DiscordIdSchema);

const TelegramInlineButtonsScopeSchema = z.enum(["off", "dm", "group", "all", "allowlist"]);

const TelegramCapabilitiesSchema = z.union([
  z.array(z.string()),
  z
    .object({
      inlineButtons: TelegramInlineButtonsScopeSchema.optional(),
    })
    .strict(),
]);

export const TelegramTopicSchema = z
  .object({
    requireMention: z.boolean().optional(),
    groupPolicy: GroupPolicySchema.optional(),
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

export const TelegramGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
    groupPolicy: GroupPolicySchema.optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
    topics: z.record(z.string(), TelegramTopicSchema.optional()).optional(),
  })
  .strict();

const TelegramCustomCommandSchema = z
  .object({
    command: z.string().transform(normalizeTelegramCommandName),
    description: z.string().transform(normalizeTelegramCommandDescription),
  })
  .strict();

const validateTelegramCustomCommands = (
  value: { customCommands?: Array<{ command?: string; description?: string }> },
  ctx: z.RefinementCtx,
) => {
  if (!value.customCommands || value.customCommands.length === 0) {
    return;
  }
  const { issues } = resolveTelegramCustomCommands({
    commands: value.customCommands,
    checkReserved: false,
    checkDuplicates: false,
  });
  for (const issue of issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["customCommands", issue.index, issue.field],
      message: issue.message,
    });
  }
};

export const TelegramAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    capabilities: TelegramCapabilitiesSchema.optional(),
    markdown: MarkdownConfigSchema,
    enabled: z.boolean().optional(),
    commands: ProviderCommandsSchema,
    customCommands: z.array(TelegramCustomCommandSchema).optional(),
    configWrites: z.boolean().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    botToken: z.string().optional().register(sensitive),
    tokenFile: z.string().optional(),
    replyToMode: ReplyToModeSchema.optional(),
    groups: z.record(z.string(), TelegramGroupSchema.optional()).optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    draftChunk: BlockStreamingChunkSchema.optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    streamMode: z.enum(["off", "partial", "block"]).optional().default("partial"),
    mediaMaxMb: z.number().positive().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    retry: RetryConfigSchema,
    network: z
      .object({
        autoSelectFamily: z.boolean().optional(),
      })
      .strict()
      .optional(),
    proxy: z.string().optional(),
    webhookUrl: z.string().optional(),
    webhookSecret: z.string().optional().register(sensitive),
    webhookPath: z.string().optional(),
    webhookHost: z.string().optional(),
    actions: z
      .object({
        reactions: z.boolean().optional(),
        sendMessage: z.boolean().optional(),
        deleteMessage: z.boolean().optional(),
        sticker: z.boolean().optional(),
      })
      .strict()
      .optional(),
    reactionNotifications: z.enum(["off", "own", "all"]).optional(),
    reactionLevel: z.enum(["off", "ack", "minimal", "extensive"]).optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    linkPreview: z.boolean().optional(),
    responsePrefix: z.string().optional(),
    ackReaction: z.string().optional(),
  })
  .strict();

export const TelegramAccountSchema = TelegramAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.telegram.dmPolicy="open" requires channels.telegram.allowFrom to include "*"',
  });
  validateTelegramCustomCommands(value, ctx);
});

export const TelegramConfigSchema = TelegramAccountSchemaBase.extend({
  // `resolveTelegramAccount` is TOLERANT — it falls back to scanning the record
  // for a key that normalizes to the requested id — so non-normalized keys stay
  // reachable and stay accepted. An UNRETRIEVABLE key is a different failure: the
  // record parse drops it outright, so there is nothing left for the tolerant
  // scan to find, the account silently falls back to the channel-level bot token,
  // and the next config write erases the block. Retrievability-only guard.
  accounts: retrievableAccountsRecord(TelegramAccountSchema.optional(), "telegram").optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.telegram.dmPolicy="open" requires channels.telegram.allowFrom to include "*"',
  });
  validateTelegramCustomCommands(value, ctx);

  const baseWebhookUrl = typeof value.webhookUrl === "string" ? value.webhookUrl.trim() : "";
  const baseWebhookSecret =
    typeof value.webhookSecret === "string" ? value.webhookSecret.trim() : "";
  if (baseWebhookUrl && !baseWebhookSecret) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "channels.telegram.webhookUrl requires channels.telegram.webhookSecret",
      path: ["webhookSecret"],
    });
  }
  if (!value.accounts) {
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    if (account.enabled === false) {
      continue;
    }
    const accountWebhookUrl =
      typeof account.webhookUrl === "string" ? account.webhookUrl.trim() : "";
    if (!accountWebhookUrl) {
      continue;
    }
    const accountSecret =
      typeof account.webhookSecret === "string" ? account.webhookSecret.trim() : "";
    if (!accountSecret && !baseWebhookSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "channels.telegram.accounts.*.webhookUrl requires channels.telegram.webhookSecret or channels.telegram.accounts.*.webhookSecret",
        path: ["accounts", accountId, "webhookSecret"],
      });
    }
  }
});

export const DiscordDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional(),
    allowFrom: DiscordIdListSchema.optional(),
    groupEnabled: z.boolean().optional(),
    groupChannels: DiscordIdListSchema.optional(),
  })
  .strict();

export const DiscordGuildChannelSchema = z
  .object({
    allow: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    users: DiscordIdListSchema.optional(),
    roles: DiscordIdListSchema.optional(),
    systemPrompt: z.string().optional(),
    includeThreadStarter: z.boolean().optional(),
    autoThread: z.boolean().optional(),
  })
  .strict();

export const DiscordGuildSchema = z
  .object({
    slug: z.string().optional(),
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    reactionNotifications: z.enum(["off", "own", "all", "allowlist"]).optional(),
    users: DiscordIdListSchema.optional(),
    roles: DiscordIdListSchema.optional(),
    channels: z.record(z.string(), DiscordGuildChannelSchema.optional()).optional(),
  })
  .strict();

const DiscordUiSchema = z
  .object({
    components: z
      .object({
        accentColor: HexColorSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export const DiscordAccountSchema = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    enabled: z.boolean().optional(),
    commands: ProviderCommandsSchema,
    configWrites: z.boolean().optional(),
    token: z.string().optional().register(sensitive),
    proxy: z.string().optional(),
    allowBots: z.boolean().optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    maxLinesPerMessage: z.number().int().positive().optional(),
    mediaMaxMb: z.number().positive().optional(),
    retry: RetryConfigSchema,
    actions: z
      .object({
        reactions: z.boolean().optional(),
        stickers: z.boolean().optional(),
        emojiUploads: z.boolean().optional(),
        stickerUploads: z.boolean().optional(),
        polls: z.boolean().optional(),
        permissions: z.boolean().optional(),
        messages: z.boolean().optional(),
        threads: z.boolean().optional(),
        pins: z.boolean().optional(),
        search: z.boolean().optional(),
        memberInfo: z.boolean().optional(),
        roleInfo: z.boolean().optional(),
        roles: z.boolean().optional(),
        channelInfo: z.boolean().optional(),
        voiceStatus: z.boolean().optional(),
        events: z.boolean().optional(),
        moderation: z.boolean().optional(),
        channels: z.boolean().optional(),
        presence: z.boolean().optional(),
      })
      .strict()
      .optional(),
    replyToMode: ReplyToModeSchema.optional(),
    // Aliases for channels.discord.dm.policy / channels.discord.dm.allowFrom. Prefer these for
    // inheritance in multi-account setups (shallow merge works; nested dm object doesn't).
    dmPolicy: DmPolicySchema.optional(),
    allowFrom: DiscordIdListSchema.optional(),
    dm: DiscordDmSchema.optional(),
    guilds: z.record(z.string(), DiscordGuildSchema.optional()).optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    execApprovals: z
      .object({
        enabled: z.boolean().optional(),
        approvers: DiscordIdListSchema.optional(),
        agentFilter: z.array(z.string()).optional(),
        sessionFilter: z.array(z.string()).optional(),
        cleanupAfterResolve: z.boolean().optional(),
        target: z.enum(["dm", "channel", "both"]).optional(),
      })
      .strict()
      .optional(),
    ui: DiscordUiSchema,
    intents: z
      .object({
        presence: z.boolean().optional(),
        guildMembers: z.boolean().optional(),
      })
      .strict()
      .optional(),
    pluralkit: z
      .object({
        enabled: z.boolean().optional(),
        token: z.string().optional().register(sensitive),
      })
      .strict()
      .optional(),
    responsePrefix: z.string().optional(),
    ackReaction: z.string().optional(),
    activity: z.string().optional(),
    status: z.enum(["online", "dnd", "idle", "invisible"]).optional(),
    activityType: z
      .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
      .optional(),
    activityUrl: z.string().url().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const activityText = typeof value.activity === "string" ? value.activity.trim() : "";
    const hasActivity = Boolean(activityText);
    const hasActivityType = value.activityType !== undefined;
    const activityUrl = typeof value.activityUrl === "string" ? value.activityUrl.trim() : "";
    const hasActivityUrl = Boolean(activityUrl);

    if ((hasActivityType || hasActivityUrl) && !hasActivity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "channels.discord.activity is required when activityType or activityUrl is set",
        path: ["activity"],
      });
    }

    if (value.activityType === 1 && !hasActivityUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "channels.discord.activityUrl is required when activityType is 1 (Streaming)",
        path: ["activityUrl"],
      });
    }

    if (hasActivityUrl && value.activityType !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "channels.discord.activityType must be 1 (Streaming) when activityUrl is set",
        path: ["activityType"],
      });
    }

    const dmPolicy = value.dmPolicy ?? value.dm?.policy ?? "pairing";
    const allowFrom = value.allowFrom ?? value.dm?.allowFrom;
    const allowFromPath =
      value.allowFrom !== undefined ? (["allowFrom"] as const) : (["dm", "allowFrom"] as const);
    requireOpenAllowFrom({
      policy: dmPolicy,
      allowFrom,
      ctx,
      path: [...allowFromPath],
      message:
        'channels.discord.dmPolicy="open" requires channels.discord.allowFrom (or channels.discord.dm.allowFrom) to include "*"',
    });
  });

export const DiscordConfigSchema = DiscordAccountSchema.extend({
  // `resolveDiscordAccount` normalizes the requested id then does an exact
  // `accounts[normalized]` lookup, so a non-normalized or unretrievable key is
  // unreachable and the account silently falls back to the channel-level bot
  // token. Shared guard closes that class here.
  accounts: accountsRecord(DiscordAccountSchema.optional(), "discord").optional(),
});

export const GoogleChatDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    requireOpenAllowFrom({
      policy: value.policy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'channels.googlechat.dm.policy="open" requires channels.googlechat.dm.allowFrom to include "*"',
    });
  });

export const GoogleChatGroupSchema = z
  .object({
    enabled: z.boolean().optional(),
    allow: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    users: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

export const GoogleChatAccountSchema = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    allowBots: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groups: z.record(z.string(), GoogleChatGroupSchema.optional()).optional(),
    // The full GCP service-account JSON, `private_key` included — a credential in
    // either shape. Neither `serviceAccount` nor `private_key` matches the
    // name-pattern fallback in redact-snapshot, so without an explicit
    // registration the key is emitted VERBATIM in the redacted config snapshot
    // (channel level and `accounts.*` alike). The record's VALUE schema is
    // registered too: that is what marks `…serviceAccount.*` sensitive so the
    // inline-JSON form is redacted field by field, not just the string form.
    serviceAccount: z
      .union([z.string(), z.record(z.string(), z.unknown().register(sensitive))])
      .optional()
      .register(sensitive),
    serviceAccountFile: z.string().optional(),
    audienceType: z.enum(["app-url", "project-number"]).optional(),
    audience: z.string().optional(),
    webhookPath: z.string().optional(),
    webhookUrl: z.string().optional(),
    botUser: z.string().optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    streamMode: z.enum(["replace", "status_final", "append"]).optional().default("replace"),
    mediaMaxMb: z.number().positive().optional(),
    replyToMode: ReplyToModeSchema.optional(),
    actions: z
      .object({
        reactions: z.boolean().optional(),
      })
      .strict()
      .optional(),
    dm: GoogleChatDmSchema.optional(),
    typingIndicator: z.enum(["none", "message", "reaction"]).optional(),
    responsePrefix: z.string().optional(),
  })
  .strict();

export const GoogleChatConfigSchema = GoogleChatAccountSchema.extend({
  // `resolveGoogleChatAccount` normalizes the requested id then does an exact
  // `accounts[normalized]` lookup, so a non-normalized or unretrievable key is
  // unreachable and the account silently inherits the channel-level service
  // account. Shared guard closes that class here.
  accounts: accountsRecord(GoogleChatAccountSchema.optional(), "googlechat").optional(),
  defaultAccount: z.string().optional(),
});

export const SlackDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupEnabled: z.boolean().optional(),
    groupChannels: z.array(z.union([z.string(), z.number()])).optional(),
    replyToMode: ReplyToModeSchema.optional(),
  })
  .strict();

export const SlackChannelSchema = z
  .object({
    enabled: z.boolean().optional(),
    allow: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    allowBots: z.boolean().optional(),
    users: z.array(z.union([z.string(), z.number()])).optional(),
    skills: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

export const SlackThreadSchema = z
  .object({
    historyScope: z.enum(["thread", "channel"]).optional(),
    inheritParent: z.boolean().optional(),
    initialHistoryLimit: z.number().int().min(0).optional(),
  })
  .strict();

const SlackReplyToModeByChatTypeSchema = z
  .object({
    direct: ReplyToModeSchema.optional(),
    group: ReplyToModeSchema.optional(),
    channel: ReplyToModeSchema.optional(),
  })
  .strict();

export const SlackAccountSchema = z
  .object({
    name: z.string().optional(),
    mode: z.enum(["socket", "http"]).optional(),
    signingSecret: z.string().optional().register(sensitive),
    webhookPath: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    enabled: z.boolean().optional(),
    commands: ProviderCommandsSchema,
    configWrites: z.boolean().optional(),
    botToken: z.string().optional().register(sensitive),
    appToken: z.string().optional().register(sensitive),
    userToken: z.string().optional().register(sensitive),
    userTokenReadOnly: z.boolean().optional().default(true),
    allowBots: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    mediaMaxMb: z.number().positive().optional(),
    reactionNotifications: z.enum(["off", "own", "all", "allowlist"]).optional(),
    reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
    replyToMode: ReplyToModeSchema.optional(),
    replyToModeByChatType: SlackReplyToModeByChatTypeSchema.optional(),
    thread: SlackThreadSchema.optional(),
    actions: z
      .object({
        reactions: z.boolean().optional(),
        messages: z.boolean().optional(),
        pins: z.boolean().optional(),
        search: z.boolean().optional(),
        permissions: z.boolean().optional(),
        memberInfo: z.boolean().optional(),
        channelInfo: z.boolean().optional(),
        emojiList: z.boolean().optional(),
      })
      .strict()
      .optional(),
    slashCommand: z
      .object({
        enabled: z.boolean().optional(),
        name: z.string().optional(),
        sessionPrefix: z.string().optional(),
        ephemeral: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // Aliases for channels.slack.dm.policy / channels.slack.dm.allowFrom. Prefer these for
    // inheritance in multi-account setups (shallow merge works; nested dm object doesn't).
    dmPolicy: DmPolicySchema.optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    dm: SlackDmSchema.optional(),
    channels: z.record(z.string(), SlackChannelSchema.optional()).optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    responsePrefix: z.string().optional(),
    ackReaction: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const dmPolicy = value.dmPolicy ?? value.dm?.policy ?? "pairing";
    const allowFrom = value.allowFrom ?? value.dm?.allowFrom;
    const allowFromPath =
      value.allowFrom !== undefined ? (["allowFrom"] as const) : (["dm", "allowFrom"] as const);
    requireOpenAllowFrom({
      policy: dmPolicy,
      allowFrom,
      ctx,
      path: [...allowFromPath],
      message:
        'channels.slack.dmPolicy="open" requires channels.slack.allowFrom (or channels.slack.dm.allowFrom) to include "*"',
    });
  });

export const SlackConfigSchema = SlackAccountSchema.safeExtend({
  mode: z.enum(["socket", "http"]).optional().default("socket"),
  signingSecret: z.string().optional().register(sensitive),
  webhookPath: z.string().optional().default("/slack/events"),
  // `resolveSlackAccount` normalizes the requested id then does an exact
  // `accounts[normalized]` lookup, so a non-normalized or unretrievable key is
  // unreachable and the account silently falls back to the channel-level
  // bot/app tokens. Shared guard closes that class here.
  accounts: accountsRecord(SlackAccountSchema.optional(), "slack").optional(),
}).superRefine((value, ctx) => {
  const baseMode = value.mode ?? "socket";
  if (baseMode === "http" && !value.signingSecret) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'channels.slack.mode="http" requires channels.slack.signingSecret',
      path: ["signingSecret"],
    });
  }
  if (!value.accounts) {
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    if (account.enabled === false) {
      continue;
    }
    const accountMode = account.mode ?? baseMode;
    if (accountMode !== "http") {
      continue;
    }
    const accountSecret = account.signingSecret ?? value.signingSecret;
    if (!accountSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'channels.slack.accounts.*.mode="http" requires channels.slack.signingSecret or channels.slack.accounts.*.signingSecret',
        path: ["accounts", accountId, "signingSecret"],
      });
    }
  }
});

export const SignalAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    account: z.string().optional(),
    httpUrl: z.string().optional(),
    httpHost: z.string().optional(),
    httpPort: z.number().int().positive().optional(),
    cliPath: ExecutableTokenSchema.optional(),
    autoStart: z.boolean().optional(),
    startupTimeoutMs: z.number().int().min(1000).max(120000).optional(),
    transport: z.enum(["json-rpc", "rest"]).optional(),
    tlsCaFile: z.string().optional(),
    tlsCertFile: z.string().optional(),
    tlsKeyFile: z.string().optional(),
    receiveMode: z.union([z.literal("on-start"), z.literal("manual")]).optional(),
    ignoreAttachments: z.boolean().optional(),
    ignoreStories: z.boolean().optional(),
    sendReadReceipts: z.boolean().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    mediaMaxMb: z.number().int().positive().optional(),
    reactionNotifications: z.enum(["off", "own", "all", "allowlist"]).optional(),
    reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
    actions: z
      .object({
        reactions: z.boolean().optional(),
      })
      .strict()
      .optional(),
    reactionLevel: z.enum(["off", "ack", "minimal", "extensive"]).optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    responsePrefix: z.string().optional(),
  })
  .strict();

export const SignalAccountSchema = SignalAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.signal.dmPolicy="open" requires channels.signal.allowFrom to include "*"',
  });
});

const SIGNAL_TLS_KEYS = ["tlsCaFile", "tlsCertFile", "tlsKeyFile"] as const;

/**
 * The id an accountId-less send resolves to, taken from the routing module that
 * actually performs the resolution rather than restated here: this schema now
 * has to agree with `normalizeAccountId` key-for-key, and a second copy of the
 * default id is one more place for the two to drift apart.
 */
const SIGNAL_DEFAULT_ACCOUNT_ID = DEFAULT_ACCOUNT_ID;

type SignalTlsKeys = Partial<Record<(typeof SIGNAL_TLS_KEYS)[number], string | undefined>>;

type SignalTlsView = SignalTlsKeys & {
  httpUrl?: string;
  httpHost?: string;
  httpPort?: number;
};

/**
 * The base URL `resolveSignalAccount` derives at runtime. Kept in step with
 * `src/signal/accounts.ts` — validating a different URL than the one the client
 * dials would let a plaintext origin through.
 *
 * Exported for the contract test that asserts this derivation equals
 * `resolveSignalAccount(...).baseUrl` for the same config: the https-vs-plaintext
 * decision below is only as good as that equality, and a test that merely checks
 * *which key* the issue lands on cannot see the two drifting apart.
 */
export const resolveSignalBaseUrlForValidation = (value: SignalTlsView): string => {
  const explicit = value.httpUrl?.trim();
  if (explicit) {
    return explicit;
  }
  const host = value.httpHost?.trim() || "127.0.0.1";
  return `http://${host}:${value.httpPort ?? 8080}`;
};

/**
 * Client-certificate material is all-or-nothing, and only means anything over
 * https.
 *
 * A partial block cannot complete a handshake. A complete block against an
 * `http://` base URL is worse than useless: undici performs no handshake on a
 * plaintext origin and `ws` discards tls options on a `ws:` URL, so the gateway
 * would ship plaintext while the operator believes it is presenting a
 * certificate. Both are rejected here and again at request time.
 */
const requireCompleteSignalTls = (params: {
  value: SignalTlsView;
  ctx: z.RefinementCtx;
  path: Array<string | number>;
  configPath: string;
}) => {
  const present = SIGNAL_TLS_KEYS.filter((key) => Boolean(params.value[key]?.trim()));
  if (present.length === 0) {
    return;
  }
  if (present.length !== SIGNAL_TLS_KEYS.length) {
    const missing = SIGNAL_TLS_KEYS.filter((key) => !present.includes(key));
    params.ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...params.path, missing[0]],
      message: `${params.configPath} requires all of tlsCaFile, tlsCertFile, tlsKeyFile when any is set (missing: ${missing.join(", ")})`,
    });
    return;
  }
  const baseUrl = resolveSignalBaseUrlForValidation(params.value);
  if (/^https:\/\//i.test(baseUrl)) {
    return;
  }
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [...params.path, "httpUrl"],
    message: `${params.configPath} sets tlsCaFile/tlsCertFile/tlsKeyFile but resolves to "${baseUrl}"; client certificates are only presented over https. Set ${params.configPath}.httpUrl to the https:// endpoint of the TLS front.`,
  });
};

/** Does this account define any TLS key of its own (vs. inheriting all)? */
const definesSignalTlsKey = (value: SignalTlsKeys): boolean =>
  SIGNAL_TLS_KEYS.some((key) => Boolean(value[key]?.trim()));

// `resolveSignalAccount` normalizes the requested id and then indexes `accounts`
// with the normalized string, so a key that is not a `normalizeAccountId` fixed
// point — or that a plain object cannot retrieve at all (`__proto__`) — is dead
// config that validates green and then silently presents the CHANNEL-level
// client certificate: the wrong mTLS identity. The guard runs on the RAW object,
// before the record parse can drop an unretrievable key, and is the one shared
// implementation used by every channel with this resolver shape.
const SignalAccountsSchema = accountsRecord(SignalAccountSchema.optional(), "signal");

export const SignalConfigSchema = SignalAccountSchemaBase.extend({
  accounts: SignalAccountsSchema.optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.signal.dmPolicy="open" requires channels.signal.allowFrom to include "*"',
  });
  // `resolveSignalAccount` merges channel-level keys under account-level ones —
  // and it synthesizes an account for EVERY id that is not listed under
  // `accounts`, not just the "default" id an accountId-less send resolves to. A
  // typo'd accountId, a routing key that outlived its account entry, and the
  // implicit default all merge to the same thing: the bare channel block.
  //
  // So the invariant is class-scoped, not instance-scoped. Guarding only
  // `accounts.default` (as earlier revisions did) leaves every other unlisted id
  // resolving to a transport view no validator ever inspected. Whenever any TLS
  // material appears anywhere in the signal block, the bare channel block must
  // itself be a complete, https-bound transport config; per-account keys may
  // then only *override* it, never be the sole source of it. That makes the
  // channel block the single validated fallback every synthesized account
  // inherits, and it is what keeps this rule in exact contract with
  // `resolveSignalTlsOptions`: no accepted config can resolve to a partial block
  // (a runtime throw) or to silent plaintext while mTLS is configured elsewhere.
  //
  // Keys the runtime cannot look up are rejected before this point, on the raw
  // object — see `checkSignalAccountKeys`.
  const accountEntries = Object.entries(value.accounts ?? {}).flatMap(([accountId, account]) =>
    account ? [[accountId, account] as const] : [],
  );
  const anyAccountDefinesTls = accountEntries.some(([, account]) => definesSignalTlsKey(account));
  const channelTlsPresent = SIGNAL_TLS_KEYS.filter((key) => Boolean(value[key]?.trim()));
  const channelTlsComplete = channelTlsPresent.length === SIGNAL_TLS_KEYS.length;
  if (anyAccountDefinesTls && !channelTlsComplete) {
    const missing = SIGNAL_TLS_KEYS.filter((key) => !channelTlsPresent.includes(key));
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [missing[0]],
      message: `channels.signal configures TLS under channels.signal.accounts but the channel-level block is incomplete (missing: ${missing.join(", ")}). Every accountId not listed under channels.signal.accounts — including the implicit "${SIGNAL_DEFAULT_ACCOUNT_ID}" used by accountId-less sends — resolves to the channel-level block verbatim, which would ${channelTlsPresent.length === 0 ? "silently fall back to plaintext" : "throw at send time"}. Set tlsCaFile, tlsCertFile and tlsKeyFile (and an https:// httpUrl) at channels.signal, then override per account as needed.`,
    });
  } else {
    // Either no TLS anywhere (no-op) or a complete channel-level block, which
    // still has to resolve to an https origin.
    requireCompleteSignalTls({ value, ctx, path: [], configPath: "channels.signal" });
  }
  const anyTlsAnywhere = channelTlsPresent.length > 0 || anyAccountDefinesTls;
  for (const [accountId, account] of accountEntries) {
    // Mirrors `mergeSignalAccountConfig`: account keys shadow channel keys.
    const merged: SignalTlsView = {
      tlsCaFile: account.tlsCaFile ?? value.tlsCaFile,
      tlsCertFile: account.tlsCertFile ?? value.tlsCertFile,
      tlsKeyFile: account.tlsKeyFile ?? value.tlsKeyFile,
      httpUrl: account.httpUrl ?? value.httpUrl,
      httpHost: account.httpHost ?? value.httpHost,
      httpPort: account.httpPort ?? value.httpPort,
    };
    // An account can blank an inherited TLS path with "" — `resolveSignalAccount`
    // would then hand back a certless view and the send would go out in the
    // clear against a block the operator configured for mTLS. Opting a single
    // account out of TLS is not a supported layout; run a second channel for it.
    if (anyTlsAnywhere && !definesSignalTlsKey(merged)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accounts", accountId, SIGNAL_TLS_KEYS[0]],
        message: `channels.signal.accounts.${accountId} clears every TLS path while channels.signal configures TLS; that resolves to a plaintext transport. Remove the blank tlsCaFile/tlsCertFile/tlsKeyFile overrides, or point this account at a separate channel.`,
      });
      continue;
    }
    requireCompleteSignalTls({
      value: merged,
      ctx,
      path: ["accounts", accountId],
      configPath: `channels.signal.accounts.${accountId}`,
    });
  }
});

export const IrcGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

export const IrcNickServSchema = z
  .object({
    enabled: z.boolean().optional(),
    service: z.string().optional(),
    password: z.string().optional().register(sensitive),
    passwordFile: z.string().optional(),
    register: z.boolean().optional(),
    registerEmail: z.string().optional(),
  })
  .strict();

export const IrcAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    tls: z.boolean().optional(),
    nick: z.string().optional(),
    username: z.string().optional(),
    realname: z.string().optional(),
    password: z.string().optional().register(sensitive),
    passwordFile: z.string().optional(),
    nickserv: IrcNickServSchema.optional(),
    channels: z.array(z.string()).optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groups: z.record(z.string(), IrcGroupSchema.optional()).optional(),
    mentionPatterns: z.array(z.string()).optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    mediaMaxMb: z.number().positive().optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    responsePrefix: z.string().optional(),
  })
  .strict();

type IrcBaseConfig = z.infer<typeof IrcAccountSchemaBase>;

function refineIrcAllowFromAndNickserv(value: IrcBaseConfig, ctx: z.RefinementCtx): void {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.irc.dmPolicy="open" requires channels.irc.allowFrom to include "*"',
  });
  if (value.nickserv?.register && !value.nickserv.registerEmail?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nickserv", "registerEmail"],
      message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail",
    });
  }
}

export const IrcAccountSchema = IrcAccountSchemaBase.superRefine((value, ctx) => {
  refineIrcAllowFromAndNickserv(value, ctx);
});

export const IrcConfigSchema = IrcAccountSchemaBase.extend({
  // Tolerant resolver (see the telegram note): non-normalized keys are reachable,
  // unretrievable ones are dropped by the parse and would silently fall back to
  // the channel-level server password. Retrievability-only guard.
  accounts: retrievableAccountsRecord(IrcAccountSchema.optional(), "irc").optional(),
}).superRefine((value, ctx) => {
  refineIrcAllowFromAndNickserv(value, ctx);
});

export const IMessageAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    cliPath: ExecutableTokenSchema.optional(),
    dbPath: z.string().optional(),
    remoteHost: z.string().optional(),
    service: z.union([z.literal("imessage"), z.literal("sms"), z.literal("auto")]).optional(),
    region: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    includeAttachments: z.boolean().optional(),
    mediaMaxMb: z.number().int().positive().optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    groups: z
      .record(
        z.string(),
        z
          .object({
            requireMention: z.boolean().optional(),
            tools: ToolPolicySchema,
            toolsBySender: ToolPolicyBySenderSchema,
          })
          .strict()
          .optional(),
      )
      .optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    responsePrefix: z.string().optional(),
  })
  .strict();

export const IMessageAccountSchema = IMessageAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.imessage.dmPolicy="open" requires channels.imessage.allowFrom to include "*"',
  });
});

export const IMessageConfigSchema = IMessageAccountSchemaBase.extend({
  // `resolveIMessageAccount` normalizes the requested id then does an exact
  // `accounts[normalized]` lookup, so a non-normalized or unretrievable key is
  // unreachable and the account silently falls back to the channel-level
  // identity/config. Shared guard closes that class here.
  accounts: accountsRecord(IMessageAccountSchema.optional(), "imessage").optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.imessage.dmPolicy="open" requires channels.imessage.allowFrom to include "*"',
  });
});

const BlueBubblesAllowFromEntry = z.union([z.string(), z.number()]);

const BlueBubblesActionSchema = z
  .object({
    reactions: z.boolean().optional(),
    edit: z.boolean().optional(),
    unsend: z.boolean().optional(),
    reply: z.boolean().optional(),
    sendWithEffect: z.boolean().optional(),
    renameGroup: z.boolean().optional(),
    setGroupIcon: z.boolean().optional(),
    addParticipant: z.boolean().optional(),
    removeParticipant: z.boolean().optional(),
    leaveGroup: z.boolean().optional(),
    sendAttachment: z.boolean().optional(),
  })
  .strict()
  .optional();

const BlueBubblesGroupConfigSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
  })
  .strict();

export const BlueBubblesAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    configWrites: z.boolean().optional(),
    enabled: z.boolean().optional(),
    serverUrl: z.string().optional(),
    password: z.string().optional().register(sensitive),
    webhookPath: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(BlueBubblesAllowFromEntry).optional(),
    groupAllowFrom: z.array(BlueBubblesAllowFromEntry).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    mediaMaxMb: z.number().int().positive().optional(),
    mediaLocalRoots: z.array(z.string()).optional(),
    sendReadReceipts: z.boolean().optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    groups: z.record(z.string(), BlueBubblesGroupConfigSchema.optional()).optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    responsePrefix: z.string().optional(),
  })
  .strict();

export const BlueBubblesAccountSchema = BlueBubblesAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.bluebubbles.accounts.*.dmPolicy="open" requires allowFrom to include "*"',
  });
});

export const BlueBubblesConfigSchema = BlueBubblesAccountSchemaBase.extend({
  // `resolveBlueBubblesAccount` normalizes the requested id then does an exact
  // `accounts[normalized]` lookup, so a non-normalized or unretrievable key is
  // unreachable and the account silently inherits the channel-level
  // serverUrl/password. Shared guard closes that class here.
  accounts: accountsRecord(BlueBubblesAccountSchema.optional(), "bluebubbles").optional(),
  actions: BlueBubblesActionSchema,
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.bluebubbles.dmPolicy="open" requires channels.bluebubbles.allowFrom to include "*"',
  });
});

export const MSTeamsChannelSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    replyStyle: MSTeamsReplyStyleSchema.optional(),
  })
  .strict();

export const MSTeamsTeamSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    replyStyle: MSTeamsReplyStyleSchema.optional(),
    channels: z.record(z.string(), MSTeamsChannelSchema.optional()).optional(),
  })
  .strict();

export const MSTeamsConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    configWrites: z.boolean().optional(),
    appId: z.string().optional(),
    appPassword: z.string().optional().register(sensitive),
    tenantId: z.string().optional(),
    webhook: z
      .object({
        port: z.number().int().positive().optional(),
        path: z.string().optional(),
      })
      .strict()
      .optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.string()).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    mediaAllowHosts: z.array(z.string()).optional(),
    mediaAuthAllowHosts: z.array(z.string()).optional(),
    requireMention: z.boolean().optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    replyStyle: MSTeamsReplyStyleSchema.optional(),
    teams: z.record(z.string(), MSTeamsTeamSchema.optional()).optional(),
    /** Max media size in MB (default: 100MB for OneDrive upload support). */
    mediaMaxMb: z.number().positive().optional(),
    /** SharePoint site ID for file uploads in group chats/channels (e.g., "contoso.sharepoint.com,guid1,guid2") */
    sharePointSiteId: z.string().optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    responsePrefix: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    requireOpenAllowFrom({
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'channels.msteams.dmPolicy="open" requires channels.msteams.allowFrom to include "*"',
    });
  });
