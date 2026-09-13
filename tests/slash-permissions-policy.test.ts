import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it } from "vitest";

import {
  defaultMemberPermissionsFor,
  isSlashPermissionLevel,
  memberHasSlashPermission,
  permissionBitFor,
  SLASH_PERMISSION_LEVELS,
} from "../src/features/slash-permissions/policy.js";

describe("slash permission policy", () => {
  it("lists exactly the four supported levels", () => {
    expect(SLASH_PERMISSION_LEVELS).toEqual([
      "everyone",
      "manage_messages",
      "manage_channels",
      "administrator",
    ]);
  });

  it("accepts every declared level and rejects anything else", () => {
    for (const level of SLASH_PERMISSION_LEVELS) {
      expect(isSlashPermissionLevel(level)).toBe(true);
    }
    expect(isSlashPermissionLevel("VIEW_AUDIT_LOG")).toBe(false);
    expect(isSlashPermissionLevel("")).toBe(false);
    expect(isSlashPermissionLevel(undefined)).toBe(false);
    expect(isSlashPermissionLevel(0)).toBe(false);
  });

  it("maps every level to the expected Discord permission bit", () => {
    expect(permissionBitFor("everyone")).toBe(0n);
    expect(permissionBitFor("manage_messages")).toBe(PermissionFlagsBits.ManageMessages);
    expect(permissionBitFor("manage_channels")).toBe(PermissionFlagsBits.ManageChannels);
    expect(permissionBitFor("administrator")).toBe(PermissionFlagsBits.Administrator);
  });

  it("serialises default_member_permissions as a decimal string", () => {
    expect(defaultMemberPermissionsFor("everyone")).toBe("0");
    expect(defaultMemberPermissionsFor("administrator")).toBe(
      PermissionFlagsBits.Administrator.toString(),
    );
  });

  it("treats a null permission set as 'everyone allowed, anything else denied'", () => {
    expect(memberHasSlashPermission(null, "everyone")).toBe(true);
    expect(memberHasSlashPermission(undefined, "everyone")).toBe(true);
    expect(memberHasSlashPermission(null, "manage_messages")).toBe(false);
    expect(memberHasSlashPermission(null, "administrator")).toBe(false);
  });

  it("delegates the check to the member's permission bitfield", () => {
    const calls: bigint[] = [];
    const permissions = {
      has: (flag: bigint) => {
        calls.push(flag);
        return flag === PermissionFlagsBits.ManageChannels;
      },
    };

    expect(memberHasSlashPermission(permissions, "manage_channels")).toBe(true);
    expect(memberHasSlashPermission(permissions, "manage_messages")).toBe(false);
    expect(calls).toEqual([PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages]);
  });
});
