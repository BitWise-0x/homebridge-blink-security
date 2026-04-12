import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CookieJar } from '../cookies.js';

describe('CookieJar', () => {
  let jar: CookieJar;

  beforeEach(() => {
    vi.clearAllMocks();
    jar = new CookieJar();
  });

  describe('parseSetCookieHeaders', () => {
    it('parses a single cookie', () => {
      jar.parseSetCookieHeaders({
        'set-cookie': ['session=abc123'],
      });
      expect(jar.getCookieHeader()).toBe('session=abc123');
    });

    it('parses multiple cookies', () => {
      jar.parseSetCookieHeaders({
        'set-cookie': ['a=1', 'b=2'],
      });
      expect(jar.getCookieHeader()).toBe('a=1; b=2');
    });

    it('extracts domain attribute', () => {
      jar.parseSetCookieHeaders({
        'set-cookie': ['sid=xyz; Domain=example.com'],
      });
      // domain should be stored as example.com
      expect(jar.getCookieHeader('example.com')).toBe('sid=xyz');
    });

    it('parses expiry date', () => {
      jar.parseSetCookieHeaders({
        'set-cookie': ['token=val; Expires=Wed, 09 Jun 2030 10:18:14 GMT'],
      });
      const cookies = jar.toJSON();
      expect(cookies[0].expires).toBeDefined();
      expect(new Date(cookies[0].expires!).getFullYear()).toBe(2030);
    });

    it('parses httpOnly flag', () => {
      jar.parseSetCookieHeaders({
        'set-cookie': ['tok=val; HttpOnly'],
      });
      const cookies = jar.toJSON();
      expect(cookies[0].httpOnly).toBe(true);
    });

    it('parses secure flag', () => {
      jar.parseSetCookieHeaders({
        'set-cookie': ['tok=val; Secure'],
      });
      const cookies = jar.toJSON();
      expect(cookies[0].secure).toBe(true);
    });

    it('does nothing when no set-cookie header', () => {
      jar.parseSetCookieHeaders({});
      expect(jar.getCookieHeader()).toBe('');
    });

    it('uses requestDomain when no Domain attribute', () => {
      jar.parseSetCookieHeaders(
        { 'set-cookie': ['sid=abc'] },
        'api.example.com'
      );
      const cookies = jar.toJSON();
      expect(cookies[0].domain).toBe('api.example.com');
    });
  });

  describe('getCookieHeader', () => {
    it('returns semicolon-joined name=value pairs', () => {
      jar.parseSetCookieHeaders({
        'set-cookie': ['a=1; Domain=example.com', 'b=2; Domain=example.com'],
      });
      expect(jar.getCookieHeader('example.com')).toBe('a=1; b=2');
    });

    it('filters expired cookies', () => {
      jar.parseSetCookieHeaders({
        'set-cookie': ['old=val; Expires=Wed, 01 Jan 2020 00:00:00 GMT'],
      });
      expect(jar.getCookieHeader()).toBe('');
    });

    it('matches exact domain', () => {
      jar.parseSetCookieHeaders({
        'set-cookie': ['a=1; Domain=example.com'],
      });
      expect(jar.getCookieHeader('example.com')).toBe('a=1');
      expect(jar.getCookieHeader('other.com')).toBe('');
    });

    it('matches subdomain per RFC 6265', () => {
      jar.parseSetCookieHeaders({
        'set-cookie': ['a=1; Domain=example.com'],
      });
      expect(jar.getCookieHeader('sub.example.com')).toBe('a=1');
    });

    it('strips leading dot from domain', () => {
      jar.parseSetCookieHeaders({
        'set-cookie': ['a=1; Domain=.example.com'],
      });
      // Domain should be stored as "example.com" (dot stripped)
      const cookies = jar.toJSON();
      expect(cookies[0].domain).toBe('example.com');
      expect(jar.getCookieHeader('example.com')).toBe('a=1');
    });
  });

  describe('clear', () => {
    it('empties the jar', () => {
      jar.parseSetCookieHeaders({
        'set-cookie': ['a=1', 'b=2'],
      });
      jar.clear();
      expect(jar.getCookieHeader()).toBe('');
      expect(jar.toJSON()).toEqual([]);
    });
  });

  describe('toJSON / fromJSON', () => {
    it('round-trips serialization', () => {
      jar.parseSetCookieHeaders({
        'set-cookie': [
          'session=abc; Domain=example.com; Expires=Wed, 09 Jun 2030 10:18:14 GMT; HttpOnly; Secure',
        ],
      });
      const json = jar.toJSON();
      const jar2 = new CookieJar();
      jar2.fromJSON(json);
      expect(jar2.getCookieHeader('example.com')).toBe('session=abc');
    });

    it('reconstructs Date objects from JSON', () => {
      jar.parseSetCookieHeaders({
        'set-cookie': ['tok=val; Expires=Wed, 09 Jun 2030 10:18:14 GMT'],
      });
      const json = JSON.parse(JSON.stringify(jar.toJSON()));
      const jar2 = new CookieJar();
      jar2.fromJSON(json);
      const cookies = jar2.toJSON();
      expect(cookies[0].expires).toBeInstanceOf(Date);
    });
  });

  describe('upsert behavior', () => {
    it('replaces existing cookie with same name and domain', () => {
      jar.parseSetCookieHeaders({
        'set-cookie': ['tok=old; Domain=example.com'],
      });
      jar.parseSetCookieHeaders({
        'set-cookie': ['tok=new; Domain=example.com'],
      });
      expect(jar.getCookieHeader('example.com')).toBe('tok=new');
      expect(jar.toJSON()).toHaveLength(1);
    });

    it('keeps cookies with same name but different domain', () => {
      jar.parseSetCookieHeaders({
        'set-cookie': ['tok=a; Domain=one.com'],
      });
      jar.parseSetCookieHeaders({
        'set-cookie': ['tok=b; Domain=two.com'],
      });
      expect(jar.toJSON()).toHaveLength(2);
    });
  });
});
