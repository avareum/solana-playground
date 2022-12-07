import { PublicKey } from "@solana/web3.js";

import { Emoji } from "../../../../../../constants";
import { PgConnection } from "../../../../connection";
import { PgTerminal } from "../../../../terminal";
import { getMetaplex, loadCache } from "../../utils";

export const processGuardRemove = async (
  rpcUrl: string = PgConnection.endpoint,
  candyMachine: string | undefined,
  candyGuard: string | undefined
) => {
  const term = await PgTerminal.get();

  term.println(`[1/1] ${Emoji.UNWRAP} Unwrapping`);

  // The candy machine id specified takes precedence over the one from the cache
  const candyMachinePkStr =
    candyMachine ?? (await loadCache()).program.candyMachine;
  if (!candyMachinePkStr) {
    throw new Error("Missing candy machine id.");
  }
  let candyMachinePk;
  try {
    candyMachinePk = new PublicKey(candyMachinePkStr);
  } catch {
    throw new Error(`Failed to parse candy machine id: ${candyMachinePkStr}`);
  }

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

  // Remove the candy guard as mint authority
  const metaplex = await getMetaplex(rpcUrl);
  const { response } = await metaplex.candyMachines().unwrapCandyGuard({
    candyGuard: candyGuardPk,
    candyMachine: candyMachinePk,
  });

  term.println(`Signature: ${response.signature}`);

  term.println(
    "\nThe candy guard is no longer the mint authority of the candy machine."
  );
  term.println(
    `  -> New mint authority: ${PgTerminal.bold(
      metaplex.identity().publicKey.toBase58()
    )}`,
    { noColor: true }
  );
};
