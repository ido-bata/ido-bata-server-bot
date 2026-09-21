import type { AudioPlayer, VoiceConnection } from "@discordjs/voice";
import type { GuildMember, VoiceBasedChannel } from "discord.js";

import { childFor, getRootLogger } from "../../lib/logger/index.js";

const logger = childFor(getRootLogger(), "timekeeper-voice-debug");

export function attachVoiceDebugging(connection: VoiceConnection, player: AudioPlayer): void {
  connection.on("error", (error) => {
    logger.warn(
      {
        event: "voice-connection-error",
        error: error.message,
        status: connection.state.status,
        voicePrivacyCode: connection.voicePrivacyCode ?? null,
        wsPing: connection.ping.ws ?? null,
        udpPing: connection.ping.udp ?? null,
      },
      "voice connection error",
    );
  });

  player.on("error", (error) => {
    logger.warn(
      {
        event: "audio-player-error",
        error: error.message,
        status: player.state.status,
        playableCount: player.playable.length,
      },
      "audio player error",
    );
  });
}

export async function logVoiceStateSnapshot(
  member: GuildMember,
  channel: VoiceBasedChannel,
  label: string,
): Promise<void> {
  await member.fetch(true);
  logger.info(
    {
      event: "voice-state",
      label,
      guildId: member.guild.id,
      channelId: member.voice.channelId,
      channelType: channel.type,
      suppress: member.voice.suppress,
      serverMute: member.voice.serverMute,
      selfMute: member.voice.selfMute,
      serverDeaf: member.voice.serverDeaf,
      selfDeaf: member.voice.selfDeaf,
      requestToSpeak: member.voice.requestToSpeakTimestamp,
      sessionId: member.voice.sessionId ?? null,
    },
    "voice state snapshot",
  );
}
