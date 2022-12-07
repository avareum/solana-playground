import { PublicKey } from "@solana/web3.js";

import { Emoji } from "../../../../../../constants";
import { PgConnection } from "../../../../connection";
import { PgTerminal } from "../../../../terminal";
import { getMetaplex, loadCache, loadConfigData } from "../../utils";

export const processGuardWithdraw = async (
  rpcUrl: string = PgConnection.endpoint,
  candyGuard: string | undefined
) => {
  const term = await PgTerminal.get();

  term.println(`[1/2] ${Emoji.LOOKING_GLASS} Loading candy guard`);

  // The candy guard id specified takes precedence over the one from the cache
  const candyGuardPkStr = candyGuard ?? (await loadCache()).program.candyGuard;
  if (!candyGuardPkStr) {
    throw new Error("Missing candy machine guard id.");
  }
  let candyGuardPk;
  try {
    candyGuardPk = new PublicKey(candyGuardPkStr);
  } catch {
    throw new Error(
      `Failed to parse candy machine guard id: ${candyGuardPkStr}`
    );
  }

  term.println(`Candy guard ID: ${candyGuardPkStr}`);

  term.println(`\n[2/2] ${Emoji.COMPUTER} Updating configuration`);

  const { guards } = await loadConfigData();
  if (!guards) {
    throw new Error("Missing guards configuration.");
  }

  const metaplex = await getMetaplex(rpcUrl);
  const { response } = await metaplex.candyMachines().deleteCandyGuard({
    candyGuard: candyGuardPk,
  });

  term.println(`Signature: ${response.signature}`);
};
