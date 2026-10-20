import { englishAdminMessages } from "./ui-admin-messages";
import { englishAdminShellMessages } from "./ui-admin-shell-messages";
import uiMessages from "./ui-messages.json";
import uiCoreMessages from "./ui-core-messages.json";
import uiProjectExtraMessages from "./ui-project-extra-messages.json";
import { uiProjectMiddleMessages } from "./ui-project-middle-messages";
import { uiUserTailMessages } from "./ui-user-tail-messages";
import { uiAuthMessages } from "./ui-auth-messages";
import { uiUserMessages } from "./ui-user-messages";
import { uiResourceMessages } from "./ui-resource-messages";
import { uiUsageMessages } from "./ui-usage-messages";
import { uiPersonalConnectionsMessages } from "./ui-personal-connections-messages";

/** Server/build input only. Clients load the versioned JSON when English is selected. */
export const englishUiMessages: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries({
    ...uiMessages, ...uiUserMessages, ...uiCoreMessages, ...uiProjectExtraMessages,
    ...uiProjectMiddleMessages, ...uiUserTailMessages, ...uiResourceMessages,
    ...uiUsageMessages, ...uiAuthMessages, ...uiPersonalConnectionsMessages, ...englishAdminMessages, ...englishAdminShellMessages,
  }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
);
