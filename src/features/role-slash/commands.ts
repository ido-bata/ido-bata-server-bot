import { SlashCommandBuilder } from "discord.js";

import type {
  RoleAction,
  RoleAssignmentContext,
  RoleAssignmentDependencies,
  RoleAssignmentError,
  RoleAssignmentResult,
} from "./types.js";

const ROLE_OPTION_NAME = "role";

export type RoleCommandDeps = RoleAssignmentDependencies & {
  // Lets tests inject a custom role lookup without touching Discord.
  resolveRoleId?: (interaction: unknown) => string | null;
};

function describeError(reason: RoleAssignmentError): string {
  switch (reason) {
    case "not_assignable":
      return "その role は slash コマンドでの付与対象に含まれていません。";
    case "no_change":
      return "role の状態に変化はありません。";
    case "permission_denied":
      return "このコマンドを実行する権限がありません。";
    case "missing_role":
      return `role を指定してください (引数 \`${ROLE_OPTION_NAME}\`)。`;
    case "role_not_found":
      return "指定された role はサーバーに存在しません。";
    case "internal_error":
      return "内部エラーが発生しました。しばらくしてから再試行してください。";
  }
}

async function emitAudit(
  deps: RoleAssignmentDependencies,
  ctx: RoleAssignmentContext,
  action: RoleAction,
  result: RoleAssignmentResult,
): Promise<void> {
  if (!deps.audit) {
    return;
  }

  const auditResult: "success" | "skipped" | "error" = result.ok
    ? "success"
    : result.reason === "no_change"
      ? "skipped"
      : "error";

  await Promise.resolve(
    deps.audit({
      action,
      guildId: ctx.guildId,
      userId: ctx.userId,
      roleId: ctx.roleId,
      result: auditResult,
      reason: result.ok ? undefined : result.reason,
    }),
  );
}

export async function runRoleAssignment(
  interaction: unknown,
  action: RoleAction,
  deps: RoleCommandDeps,
): Promise<RoleAssignmentResult> {
  const roleId =
    deps.resolveRoleId?.(interaction) ?? readRoleOptionId(interaction as RoleOptionReader);

  if (!roleId) {
    return { ok: false, reason: "missing_role" };
  }

  const ctx: RoleAssignmentContext = {
    guildId: (interaction as { guildId: string }).guildId,
    userId: (interaction as { user: { id: string } }).user.id,
    roleId,
  };

  return performRoleAssignment(action, ctx, deps);
}

export function replyForResult(result: RoleAssignmentResult, roleId: string): {
  content: string;
  ephemeral: boolean;
} {
  if (result.ok) {
    const verb = result.action === "assign" ? "付与" : "解除";
    return {
      content: `<@&${roleId}> を${verb}しました。`,
      ephemeral: true,
    };
  }

  return {
    content: describeError(result.reason),
    ephemeral: true,
  };
}

export async function performRoleAssignment(
  action: RoleAction,
  ctx: RoleAssignmentContext,
  deps: RoleAssignmentDependencies,
): Promise<RoleAssignmentResult> {
  const resolve = async (): Promise<RoleAssignmentResult> => {
    if (!ctx.roleId) {
      return { ok: false, reason: "missing_role" };
    }

    const rule = (deps.findRuleByRoleId ?? (() => null))(ctx.roleId);

    if (!rule) {
      return { ok: false, reason: "not_assignable" };
    }

    const hasRole = deps.hasRole ?? (async () => false);

    const alreadyHas = await hasRole(ctx.guildId, ctx.userId, ctx.roleId);

    if (action === "assign" && alreadyHas) {
      return { ok: false, reason: "no_change" };
    }

    if (action === "remove" && !alreadyHas) {
      return { ok: false, reason: "no_change" };
    }

    if (!deps.withMemberRoleManager) {
      return { ok: false, reason: "internal_error" };
    }

    const result = await deps.withMemberRoleManager(ctx.guildId, ctx.userId, async (roles) => {
      if (action === "assign") {
        await roles.add(ctx.roleId);
      } else {
        await roles.remove(ctx.roleId);
      }
      return { ok: true as const, action, roleId: ctx.roleId };
    });

    if (!result) {
      return { ok: false, reason: "role_not_found" };
    }

    return result;
  };

  const result = await resolve();
  await emitAudit(deps, ctx, action, result);
  return result;
}

type RoleOptionReader = {
  options: {
    get: (name: string, required: boolean) => { value?: string } | null;
  };
};

function readRoleOptionId(interaction: RoleOptionReader): string | null {
  const option = interaction.options.get(ROLE_OPTION_NAME, true);

  if (!option || !option.value) {
    return null;
  }

  // Discord returns the role snowflake as a string when the option type is
  // Role. We just forward it.
  return option.value;
}

export const ROLE_OPTION = ROLE_OPTION_NAME;

export const roleCommand = {
  name: "role",
  description: "リアクションロールを slash 経由で操作する (reaction と同等)。",
  buildPayload: () =>
    new SlashCommandBuilder()
      .setName("role")
      .setDescription("リアクションロールを slash 経由で操作する (reaction と同等)。")
      .addSubcommand((sub) =>
        sub
          .setName("assign")
          .setDescription("自分へ role を付与する (assignableViaSlash=true の role のみ)。")
          .addRoleOption((option) =>
            option.setName(ROLE_OPTION_NAME).setDescription("付与対象の role").setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("自分から role を解除する (assignableViaSlash=true の role のみ)。")
          .addRoleOption((option) =>
            option.setName(ROLE_OPTION_NAME).setDescription("解除対象の role").setRequired(true),
          ),
      ),
} as const;