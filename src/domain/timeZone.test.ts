import { describe, expect, it } from 'vitest';
import { isValidNamedTimeZone } from './timeZone';

describe('isValidNamedTimeZone', () => {
  it.each(['UTC', 'Asia/Seoul', 'America/New_York', 'Etc/GMT+9'])('accepts named zone %s', (value) => {
    expect(isValidNamedTimeZone(value)).toBe(true);
  });

  it.each(['', 'Mars/Olympus', '+09:00', '-0500', '+09'])('rejects invalid or fixed-offset zone %s', (value) => {
    expect(isValidNamedTimeZone(value)).toBe(false);
  });
});
