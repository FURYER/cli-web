import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export type AuthContext = { kind: "token" };

export type AuthFailure = { error: string; status: 401 | 403 | 500 };

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function safeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function resolveAuth(input: {
  authorization?: string;
  token?: string;
}): AuthContext | AuthFailure {
  const accessToken = process.env.ACCESS_TOKEN?.trim();
  if (!accessToken) {
    return {
      error: "Server misconfigured: set ACCESS_TOKEN",
      status: 500,
    };
  }

  const bearer =
    input.authorization?.startsWith("Bearer ")
      ? input.authorization.slice("Bearer ".length).trim()
      : input.token?.trim();

  if (bearer && safeEqualString(bearer, accessToken)) {
    return { kind: "token" };
  }

  return { error: "Unauthorized", status: 401 };
}

function isFailure(result: AuthContext | AuthFailure): result is AuthFailure {
  return "error" in result && "status" in result;
}

export async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthContext | null> {
  const authorization = headerValue(request.headers.authorization);
  const query = request.query as { token?: string };
  const token = typeof query.token === "string" ? query.token : undefined;
  const result = resolveAuth({ authorization, token });
  if (isFailure(result)) {
    await reply.code(result.status).send({ error: result.error });
    return null;
  }
  return result;
}

export function authenticateFromHeaders(headers: {
  authorization?: string;
  token?: string;
}): AuthContext | AuthFailure {
  return resolveAuth(headers);
}
