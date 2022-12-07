import { SERVER_URL } from "../../constants";
import { PgCommon } from "./common";
import { PgExplorer, ExplorerJSON } from "./explorer";
import { PgValidator } from "./validator";

export interface ShareJSON {
  files: {
    [key: string]: {
      content?: string;
      current?: boolean;
      tabs?: boolean;
    };
  };
}

export class PgShare {
  /**
   * @returns shared project info
   */
  static async get(id: string) {
    const resp = await fetch(`${SERVER_URL}/share${id}`);

    await PgCommon.checkForRespErr(resp.clone());

    const shareData: ShareJSON = await resp.json();

    // Convert ShareJSON into new ExplorerJSON to make shares backwards compatible
    // with the old shares
    const newData: ExplorerJSON = { files: {} };

    for (const path in shareData.files) {
      const fileInfo = shareData.files[path];
      newData.files[path] = {
        content: fileInfo.content,
        meta: {
          current: fileInfo.current,
          tabs: fileInfo.tabs,
        },
      };
    }

    return newData;
  }

  /**
   * Share a new project.
   *
   * @returns object id if sharing is successful.
   */
  static async new(explorer: PgExplorer) {
    const resp = await fetch(`${SERVER_URL}/new`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        explorer: explorer.getShareFiles(),
      }),
    });

    const arrayBuffer = await PgCommon.checkForRespErr(resp.clone());

    const objectId = PgCommon.decodeBytes(arrayBuffer);

    return objectId;
  }

  /**
   * Get whether the current pathname is in a valid format
   *
   * @param pathname current pathname
   * @returns whether the current pathname is in a valid format
   */
  static isValidPathname(pathname: string) {
    return PgValidator.isHex(pathname.substring(1));
  }
}
