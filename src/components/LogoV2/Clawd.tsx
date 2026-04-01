import * as React from 'react';
import { useState } from 'react';
import { Box, Text, useAnimationFrame } from '../../ink.js';
import { env } from '../../utils/env.js';
import { getInitialSettings } from '../../utils/settings/settings.js';
export type ClawdPose = 'default' | 'arms-up'
| 'look-left'
| 'look-right';

type Props = {
  pose?: ClawdPose;
};

// Kaomoji faces for each pose
const FACES: Record<ClawdPose, string> = {
  default:      '( ◕ᴗ◕)',
  'look-left':  '(◕ᴗ◕ )',
  'look-right': '( ◕ᴗ◕)',
  'arms-up':    '(ˆ◡ˆ )',
};

const SPARKLES = ['✧', '✿', '♡', '~', '✧', '♡'];

export function Clawd({ pose = 'default' }: Props = {}): React.ReactNode {
  const [reducedMotion] = useState(() => getInitialSettings().prefersReducedMotion ?? false);
  const [ref, time] = useAnimationFrame(reducedMotion ? null : 200);
  const frame = Math.floor(time / 200);

  const face = FACES[pose];
  const sparkle = SPARKLES[frame % SPARKLES.length];

  // Ears twitch on arms-up pose
  const ears = pose === 'arms-up' ? '(\\(\\ ' : ' (\\(\\';

  return (
    <Box ref={ref} flexDirection="column">
      <Text><Text color="clawd_body">{ears}</Text>  <Text color="startupAccent">{sparkle}</Text></Text>
      <Text><Text color="clawd_body">{' '}{face}</Text> <Text color="startupAccent">{sparkle === '♡' ? '✧' : '♡'}</Text></Text>
      <Text><Text color="clawd_body">{' o'}</Text> <Text dimColor={true}>{'zzz'[frame % 3]||''}</Text></Text>
    </Box>
  );
}
