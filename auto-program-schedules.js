(function (root) {
  'use strict';
  const NEWS_URL = 'https://abema.tv/now-on-air/abema-news';
  const DEFAULTS = {
    enabled: false, primaryEnabled: true,
    keyword: '報道ステーション', url: NEWS_URL, days: [2, 3, 4, 5, 6],
    startTime: '00:00', endTime: '02:00', closeOwnedTab: true, openActive: false,
    missingPollsToStop: 2,
    newsEnabled: true, newsStartTime: '00:01', newsEndTime: '01:20',
    cnnEnabled: true, cnnStartTime: '16:00', cnnEndTime: '16:20'
  };

  function scheduleState(now, settings) {
    // ABEMA schedules always use Japan time, independent of the computer's timezone.
    const japan = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const day = japan.getUTCDay();
    const today = japan.toISOString().slice(0, 10);
    const previous = new Date(japan.getTime() - 86400000).toISOString().slice(0, 10);
    const minutes = value => {
      const [hour, minute] = String(value).split(':').map(Number);
      return hour * 60 + minute;
    };
    const start = minutes(settings.startTime), end = minutes(settings.endTime);
    const minute = japan.getUTCHours() * 60 + japan.getUTCMinutes();
    const days = new Set((settings.days || []).map(Number));
    if (start === end) return { inWindow: days.has(day), windowKey: today };
    if (start < end) return {
      inWindow: days.has(day) && minute >= start && minute < end, windowKey: today
    };
    if (minute >= start) return { inWindow: days.has(day), windowKey: today };
    return { inWindow: minute < end && days.has((day + 6) % 7),
      windowKey: minute < end ? previous : today };
  }

  function programs(settings) {
    const s = { ...DEFAULTS, ...settings };
    const daily = [0, 1, 2, 3, 4, 5, 6];
    return [
      { ...s, id: 'primary', label: s.keyword, enabled: s.primaryEnabled, timed: false },
      { ...s, id: 'news', label: 'ABEMA NEWSチャンネル', keyword: '', url: NEWS_URL,
        enabled: s.newsEnabled, days: daily, startTime: s.newsStartTime, endTime: s.newsEndTime, timed: true },
      { ...s, id: 'cnn', label: 'CNNj', keyword: '', url: NEWS_URL,
        enabled: s.cnnEnabled, days: daily, startTime: s.cnnStartTime, endTime: s.cnnEndTime, timed: true }
    ];
  }

  function windows(now, settings, force = false) {
    return programs(settings).flatMap(program => {
      const schedule = scheduleState(now, program);
      if (!force && (!settings.enabled || !program.enabled || !schedule.inWindow)) return [];
      // Keep the original primary key for sessions made by previous versions.
      const windowKey = program.id === 'primary' ? schedule.windowKey : `${program.id}:${schedule.windowKey}`;
      return [{ ...program, windowKey }];
    });
  }

  root.ABEMAAutoPrograms = { DEFAULTS, programs, scheduleState, windows };
})(globalThis);
