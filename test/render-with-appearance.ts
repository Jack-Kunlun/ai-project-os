import {createElement,type ReactNode} from "react";
import {renderToStaticMarkup as renderMarkup} from "react-dom/server";
import {AppearanceProvider} from "../src/components/appearance-provider";
/** Render presentation tests inside the same required context as the app. */
export function renderToStaticMarkup(children:ReactNode):string{
 return renderMarkup(createElement(AppearanceProvider,null,children));
}
