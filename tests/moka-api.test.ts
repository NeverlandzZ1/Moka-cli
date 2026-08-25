import { describe, expect, it } from 'vitest';
import { defaultInterviewListBody, shanghaiDayBounds } from '../src/moka-api.js';

describe('default interview discovery ranges', () => {
  it('builds the full today range using Asia/Shanghai day boundaries', () => {
    const now = Date.parse('2026-08-25T12:00:00+08:00');
    expect(shanghaiDayBounds(now)).toEqual({
      start: 1787587200000,
      end: 1787673599000,
    });
    expect(defaultInterviewListBody({
      jobPreference: 'all',
      countType: 'afterToday',
      order: 'desc',
      minStartDate: 123,
      currentPage: 9,
      pageSize: 10,
    }, now)).toEqual({
      jobPreference: 'all',
      pageSize: 10,
      countType: 'today',
      order: 'asc',
      minStartDate: 1787587200000,
      maxStartDate: 1787673599000,
      currentPage: 1,
    });
  });
});
