// Spoken tutorial: how the zones work.

import type { App } from '../app';
import type { Option } from '../ui/ui';

export async function runTutorial(app: App): Promise<void> {
  const explain = [
    app.P('tut_intro'),
    app.P(app.slots === 5 ? 'tut_grid6' : 'tut_grid4'),
    app.P('tut_tap'),
    app.P('tut_hold'),
    app.P('tut_menu'),
    app.P('tut_feedback'),
  ];
  await app.say(...explain);
  const options: (Option | null)[] = [app.optKey('z_next'), app.optKey('z_repeat')];
  while (options.length < app.slots) options.push(null);
  let prompt = [app.P('tut_try')];
  for (;;) {
    const i = await app.ask({ prompt, options });
    if (i === 0) break;
    if (i === 1) {
      await app.say(...explain);
      prompt = [app.P('tut_try')];
    } else prompt = [app.P('tut_try_wrong')];
  }
  await app.say(app.P('tut_done'));
}
