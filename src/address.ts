export type Address = {
  host: string;
  port: number;
};

/** `host:port`, `name:port`, or `[ipv6]:port`. */
export function parseAddress(input: string, path: string): Address {
  const value = input.trim();
  if (value.startsWith("[")) {
    const match = /^\[([^\]]+)\]:(\d+)$/.exec(value);
    if (!match) throw new Error(`${path} is not a valid [ipv6]:port address: ${input}`);
    return checked(match[1], match[2], path, input);
  }
  const colon = value.lastIndexOf(":");
  if (colon <= 0 || colon === value.length - 1) {
    throw new Error(`${path} must be host:port (got ${JSON.stringify(input)})`);
  }
  return checked(value.slice(0, colon), value.slice(colon + 1), path, input);
}

function checked(host: string, portText: string, path: string, raw: string): Address {
  if (!/^\d+$/.test(portText)) {
    throw new Error(`${path} has a non-numeric port in ${JSON.stringify(raw)}`);
  }
  const port = Number(portText);
  if (port < 0 || port > 65535) {
    throw new Error(`${path} port is out of range in ${JSON.stringify(raw)}`);
  }
  if (!host) throw new Error(`${path} is missing a host in ${JSON.stringify(raw)}`);
  return { host, port };
}

export function formatAddress(address: Address): string {
  return address.host.includes(":") ? `[${address.host}]:${address.port}` : `${address.host}:${address.port}`;
}

/** True when the string is a backend address rather than a named server. */
export function looksLikeAddress(value: string): boolean {
  return value.includes(":") || value.includes("$") || value.startsWith("[");
}
