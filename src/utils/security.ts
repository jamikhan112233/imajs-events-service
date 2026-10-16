const encoder = new TextEncoder()

export function randomHex(bytes = 32): string {
  const data = new Uint8Array(bytes)
  crypto.getRandomValues(data)
  return toHex(data)
}

export function randomCode(length = 12): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const output: string[] = []
  const random = new Uint8Array(length)
  crypto.getRandomValues(random)
  for (const value of random) output.push(alphabet[value % alphabet.length])
  return output.join('')
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return toHex(new Uint8Array(digest))
}

export async function hashPassword(
  password: string,
  saltHex = randomHex(16)
): Promise<{ salt: string; hash: string }> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: fromHex(saltHex),
      iterations: 210_000,
    },
    key,
    256
  )
  return { salt: saltHex, hash: toHex(new Uint8Array(bits)) }
}

export async function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string
): Promise<boolean> {
  const actual = (await hashPassword(password, salt)).hash
  if (actual.length !== expectedHash.length) return false
  let difference = 0
  for (let index = 0; index < actual.length; index++) {
    difference |= actual.charCodeAt(index) ^ expectedHash.charCodeAt(index)
  }
  return difference === 0
}

function toHex(value: Uint8Array): string {
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function fromHex(value: string): ArrayBuffer {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) {
    throw new Error('Invalid hex value')
  }
  const buffer = new ArrayBuffer(value.length / 2)
  const output = new Uint8Array(buffer)
  for (let index = 0; index < output.length; index++) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return buffer
}
