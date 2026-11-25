// @design DES-WEB-MCP
// Hosted MCP entry over Streamable HTTP (BUI-2099). Every request passes the bearer-token check of @buildproven/mcp-oauth first: no or
// an invalid token is a 401 whose WWW-Authenticate header points at /.well-known/oauth-protected-resource, and another subject is a 403.
// With `WANDERPAGE_SIGNUP=open` (BUI-2215) every valid token's subject is served, each with its own owner session.
import { authorizeMcpRequest, resourceUrls, signupMode, type AuthorizeConfig, type SignupMode } from "@buildproven/mcp-oauth";
import { createMcpHandler, type AuthInfo, type McpHttpHandler } from "@modelcontextprotocol/server";
import { createHostedServer, type HostedServerOptions } from "@/app/api/mcp/_hosted/server";

/** The settings prefix shared by the OAuth server and the token check: `WANDERPAGE_OAUTH_ISSUER` and so on. */
export const hostedPrefix = "WANDERPAGE";

type Env = Readonly<Record<string, string | undefined>>;
export type HostedDependencies = Pick<HostedServerOptions, "stories" | "sessions" | "removeObjects" | "uploadLinks" | "downloadLinks">;

export type HostedMcpOptions = {
  /** Settings source, read on each request. Default `process.env`. */
  env?: Env;
  /** Replaces the issuer's remote key set (tests). */
  keys?: AuthorizeConfig["keys"];
  /** The story service and owner sessions, or the 503 that names the missing settings. */
  dependencies: () => HostedDependencies | Response;
};

export function createHostedMcpHandler(options: HostedMcpOptions) {
  const env = () => options.env ?? process.env;
  return async (request: Request): Promise<Response> => {
    const auth = await authorizeMcpRequest(request, { prefix: hostedPrefix, env: env(), keys: options.keys });
    if (!auth.ok) return auth.response;
    const dependencies = options.dependencies();
    if (dependencies instanceof Response) return dependencies;
    // One handler per request (the SDK transport is per request and keeps no session), so each request's server uses that request's
    // dependencies, never the first request's.
    const settings = env(),
      signup = signupMode(hostedPrefix, settings),
      ownerSubject = (settings[`${hostedPrefix}_OWNER_SUBJECT`] ?? "").trim();
    const handler: McpHttpHandler = createMcpHandler(({ authInfo }) =>
      createHostedServer({
        ...dependencies,
        subject: servedSubject(subjectOf(authInfo), signup, ownerSubject),
        ownerSubject,
        signup,
        publicOrigin: new URL(request.url).origin,
      })
    );
    return handler.fetch(request, { authInfo: auth.value });
  };
}

function subjectOf(authInfo: AuthInfo | undefined) {
  const subject = authInfo?.extra?.subject;
  return typeof subject === "string" ? subject : undefined;
}

/**
 * The subject whose owner session serves the request. An open-mode token names the GitHub login in lower case, while an owner-mode
 * token names `OWNER_GITHUB_LOGIN` as configured; so in open mode the owner's login maps back to `WANDERPAGE_OWNER_SUBJECT`, and the
 * owner keeps the session and stories bound before signup opened.
 */
function servedSubject(subject: string | undefined, signup: SignupMode, ownerSubject: string) {
  if (signup === "open" && subject && ownerSubject && subject.toLowerCase() === ownerSubject.toLowerCase()) return ownerSubject;
  return subject;
}

/** RFC 9728 metadata: the MCP URL of this deployment and the authorization server that signs its owner in. */
export function protectedResourceMetadata(request: Request, env: Env = process.env) {
  const name = `${hostedPrefix}_OAUTH_ISSUER`,
    issuer = (env[name] ?? "").trim();
  if (!isSecureUrl(issuer)) return configurationProblem(issuer ? [] : [name], issuer ? [name] : []);
  return Response.json(
    {
      resource: resourceUrls(request).mcpUrl,
      authorization_servers: [issuer.replace(/\/+$/, "")],
      bearer_methods_supported: ["header"],
      resource_name: "Wanderpage",
    },
    { headers: { "cache-control": "no-store" } }
  );
}

/** A 503 naming each missing or unusable setting, never its value. */
export function configurationProblem(missing: string[], invalid: string[], detail = "not an https URL") {
  const parts = [missing.length ? `missing ${missing.join(", ")}` : "", invalid.length ? `${detail}: ${invalid.join(", ")}` : ""].filter(
    Boolean
  );
  return Response.json(
    { error: "server_error", error_description: `Hosted Wanderpage MCP configuration: ${parts.join("; ")}`, missing, invalid },
    { status: 503, headers: { "cache-control": "no-store" } }
  );
}

function isSecureUrl(value: string) {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}
