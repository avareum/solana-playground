import { useEffect } from "react";

import { PgCommon } from "../utils/pg";

export const useSendAndReceiveCustomEvent = <T,>(
  cb: (data: T) => Promise<any>,
  eventName: string
) => {
  useEffect(() => {
    const eventNames = PgCommon.getSendAndReceiveEventNames(eventName);

    const handleSend = async (e: UIEvent & { detail: T }) => {
      try {
        const data = await cb(e.detail);
        PgCommon.createAndDispatchCustomEvent(eventNames.receive, { data });
      } catch (e: any) {
        PgCommon.createAndDispatchCustomEvent(eventNames.receive, {
          error: e.message,
        });
      }
    };

    document.addEventListener(eventNames.send, handleSend as any);

    return () =>
      document.removeEventListener(eventNames.send, handleSend as any);
  }, [eventName, cb]);
};
