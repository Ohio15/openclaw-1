import { loadConfig } from "../../config/io.js";
import { runSecurityAudit } from "../../security/audit.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

export const securityHandlers: GatewayRequestHandlers = {
  "security.audit": async ({ respond, params }) => {
    try {
      const config = await loadConfig();
      const deep = params?.deep === true;
      const report = await runSecurityAudit({
        config,
        deep,
        includeFilesystem: true,
        includeChannelSecurity: true,
      });
      respond(true, report, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
