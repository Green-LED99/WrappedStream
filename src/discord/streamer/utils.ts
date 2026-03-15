export type StreamKeyParts = {
  type: string;
  guildId: string;
  channelId: string;
  userId: string;
};

export function generateStreamKey(
  type: string,
  guildId: string | null,
  channelId: string,
  userId: string
): string {
  return `${type}:${guildId ?? channelId}:${channelId}:${userId}`;
}

export function parseStreamKey(key: string): StreamKeyParts {
  const [type, guildId, channelId, userId] = key.split(':');
  return {
    type: type ?? '',
    guildId: guildId ?? '',
    channelId: channelId ?? '',
    userId: userId ?? '',
  };
}
