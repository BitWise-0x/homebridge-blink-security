import type { IncomingHttpHeaders } from 'http';

interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
}

export class CookieJar {
  private cookies: Cookie[] = [];

  parseSetCookieHeaders(
    headers: IncomingHttpHeaders,
    requestDomain?: string
  ): void {
    const setCookies = headers['set-cookie'];
    if (!setCookies) {
      return;
    }

    for (const header of setCookies) {
      const parts = header.split(';').map(s => s.trim());
      const [nameValue, ...attrs] = parts;
      const eqIdx = nameValue.indexOf('=');
      if (eqIdx < 0) {
        continue;
      }

      const name = nameValue.slice(0, eqIdx).trim();
      const value = nameValue.slice(eqIdx + 1).trim();

      const cookie: Cookie = { name, value };

      for (const attr of attrs) {
        const [key, val] = attr.split('=').map(s => s.trim());
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'domain') {
          // Strip leading dot per RFC 6265 §5.2.3
          cookie.domain = val.startsWith('.') ? val.slice(1) : val;
        } else if (lowerKey === 'path') {
          cookie.path = val;
        } else if (lowerKey === 'expires') {
          cookie.expires = new Date(val);
        } else if (lowerKey === 'httponly') {
          cookie.httpOnly = true;
        } else if (lowerKey === 'secure') {
          cookie.secure = true;
        }
      }

      if (!cookie.domain && requestDomain) {
        cookie.domain = requestDomain;
      }

      const existingIdx = this.cookies.findIndex(
        c => c.name === name && c.domain === cookie.domain
      );
      if (existingIdx >= 0) {
        this.cookies[existingIdx] = cookie;
      } else {
        this.cookies.push(cookie);
      }
    }
  }

  getCookieHeader(domain?: string): string {
    const now = new Date();
    const matching = this.cookies.filter(c => {
      if (c.expires && c.expires < now) {
        return false;
      }
      if (domain && c.domain) {
        // RFC 6265 §5.4 domain matching: exact match or request is a subdomain of cookie domain
        return domain === c.domain || domain.endsWith(`.${c.domain}`);
      }
      return true;
    });

    return matching.map(c => `${c.name}=${c.value}`).join('; ');
  }

  clear(): void {
    this.cookies = [];
  }

  toJSON(): Cookie[] {
    return [...this.cookies];
  }

  fromJSON(data: Cookie[]): void {
    this.cookies = data.map(c => ({
      ...c,
      expires: c.expires ? new Date(c.expires) : undefined,
    }));
  }
}
