import { Playnet, TransactionStatus } from "@solana-playground/playnet";
import {
  Connection,
  PublicKey,
  TransactionConfirmationStatus,
  VersionedTransaction,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import { utils } from "@project-serum/anchor";

import { Endpoint, EventName } from "../../../constants";
import { PgSerde } from "./serde";
import { PgCommon } from "../common";
import { RpcRequest, RpcResponse, RpcResponseWithContext } from "./types";
import { PgSet } from "../types";

export class PgPlaynetRpc {
  /**
   * Override `window.fetch` and `fetch` that `web3.js` uses
   *
   * @param playnet Playnet instance. The default fetch will be used if `undefined`.
   * @returns the new `fetch` function
   */
  static overrideFetch(playnet?: Playnet) {
    let newFetch;
    if (playnet) {
      newFetch = this._getNewFetch(playnet);
    } else {
      newFetch = defaultFetch;
    }

    // This overrides web3.js methods
    this._setCustomFetch({ fetch: newFetch });

    // This overrides global fetch method(i.e solana-cli-wasm)
    window.fetch = newFetch;

    return newFetch;
  }

  /**
   * Create a new `fetch` function that detects the requests of Solana JSON-RPC methods
   *
   * @param playnet Playnet instance
   * @returns the new `fetch` function
   */
  private static _getNewFetch(playnet: Playnet) {
    return async (...args: Parameters<Window["fetch"]>) => {
      // Get whether the request url is playnet
      let parsedRequest: RpcRequest | null = null;
      if (typeof args[0] === "string") {
        const url = args[0];
        if (this._isUrlPlaynet(url)) {
          const requestBody = args[1]?.body;
          if (requestBody) {
            parsedRequest = JSON.parse(requestBody.toString());
          }
        }
      } else if (typeof args[0] === "object") {
        const request = args[0] as Request;
        if (this._isUrlPlaynet(request.url)) {
          parsedRequest = await request.json();
        }
      }

      if (parsedRequest) {
        const slot = PgCommon.bigintToInt(playnet.rpc.getSlot());

        const context = {
          apiVersion: "1.15.0",
          slot,
        };

        switch (parsedRequest.method) {
          case "getAccountInfo": {
            const [address] = parsedRequest.params;
            const account = playnet.rpc.getAccountInfo(address);
            const lamports = PgCommon.bigintToInt(account.lamports);

            return this._createRpcResponse<"getAccountInfo">(
              parsedRequest,
              context,
              {
                // @ts-ignore
                value:
                  lamports === 0
                    ? null
                    : {
                        data: [
                          utils.bytes.base64.encode(Buffer.from(account.data)),
                          "base64",
                        ],
                        executable: account.executable,
                        lamports,
                        owner: new PublicKey(account.owner.toBytes()),
                        rentEpoch: PgCommon.bigintToInt(account.rentEpoch),
                      },
              }
            );
          }

          case "getBalance": {
            const [address] = parsedRequest.params;
            const account = playnet.rpc.getAccountInfo(address);
            return this._createRpcResponse<"getBalance">(
              parsedRequest,
              context,
              {
                value: PgCommon.bigintToInt(account.lamports),
              }
            );
          }

          case "getSlot": {
            return this._createRpcResponse<"getSlot">(parsedRequest, context, {
              result: slot,
            });
          }

          case "getBlockHeight": {
            return this._createRpcResponse<"getBlockHeight">(
              parsedRequest,
              context,
              {
                result: PgCommon.bigintToInt(playnet.rpc.getBlockHeight()),
              }
            );
          }

          case "getGenesisHash": {
            return this._createRpcResponse<"getGenesisHash">(
              parsedRequest,
              context,
              {
                result: playnet.rpc.getGenesisHash(),
              }
            );
          }

          case "getLatestBlockhash": {
            const blockhashInfo = playnet.rpc.getLatestBlockhash();
            return this._createRpcResponse<"getLatestBlockhash">(
              parsedRequest,
              context,
              {
                value: {
                  blockhash: blockhashInfo.blockhash(),
                  lastValidBlockHeight: PgCommon.bigintToInt(
                    blockhashInfo.lastValidBlockHeight()
                  ),
                },
              }
            );
          }

          case "getRecentBlockhash": {
            return this._createRpcResponse<"getRecentBlockhash">(
              parsedRequest,
              context,
              {
                value: {
                  blockhash: playnet.rpc.getLatestBlockhash().blockhash(),
                  feeCalculator: { lamportsPerSignature: 5000 },
                },
              }
            );
          }

          case "getMinimumBalanceForRentExemption": {
            const [dataLen] = parsedRequest.params;
            return this._createRpcResponse<"getMinimumBalanceForRentExemption">(
              parsedRequest,
              context,
              {
                result: PgCommon.bigintToInt(
                  playnet.rpc.getMinimumBalanceForRentExemption(dataLen)
                ),
              }
            );
          }

          case "getFeeForMessage": {
            const [msgBase64] = parsedRequest.params;
            const rustMsgBytes = PgSerde.serializeMsg(msgBase64);

            const fee = PgCommon.bigintToInt(
              playnet.rpc.getFeeForMessage(rustMsgBytes)
            );

            return this._createRpcResponse<"getFeeForMessage">(
              parsedRequest,
              context,
              {
                result:
                  fee === undefined
                    ? undefined
                    : {
                        context: { slot },
                        value: fee,
                      },
              }
            );
          }

          case "simulateTransaction": {
            const [txBase64] = parsedRequest.params;
            const rustTxBytes = PgSerde.serializeTx(txBase64);

            const simulationResult =
              playnet.rpc.simulateTransaction(rustTxBytes);

            const returnData = simulationResult.returnData();

            return this._createRpcResponse<"simulateTransaction">(
              parsedRequest,
              context,
              {
                result: {
                  context,
                  value: {
                    err: simulationResult.error() ?? null,
                    logs: simulationResult.logs(),
                    unitsConsumed: PgCommon.bigintToInt(
                      simulationResult.unitsConsumed()
                    ),
                    returnData: returnData
                      ? {
                          programId: returnData.programId.toString(),
                          data: [
                            utils.bytes.base64.encode(
                              Buffer.from(returnData.data)
                            ),
                            "base64",
                          ],
                        }
                      : null,
                    accounts: null,
                  },
                },
              }
            );
          }

          case "sendTransaction": {
            const [txBase64] = parsedRequest.params;
            const rustTxBytes = PgSerde.serializeTx(txBase64);

            const txResult = playnet.rpc.sendTransaction(rustTxBytes);
            this._handleError(txResult);

            return this._createRpcResponse<"sendTransaction">(
              parsedRequest,
              context,
              {
                result: txResult.txHash(),
              }
            );
          }

          case "getSignatureStatuses": {
            const [signatures] = parsedRequest.params;

            const statusesResult = playnet.rpc.getSignatureStatuses(signatures);
            const statuses: (TransactionStatus | undefined)[] =
              statusesResult.statuses();

            return this._createRpcResponse<"getSignatureStatuses">(
              parsedRequest,
              context,
              {
                result: {
                  context,
                  value: statuses.map((status) =>
                    status
                      ? {
                          confirmationStatus: (() => {
                            switch (status.confirmationStatus) {
                              case 0:
                                return "processed";
                              case 1:
                                return "confirmed";
                              case 2:
                                return "finalized";
                              default:
                                return "finalized";
                            }
                          })() as TransactionConfirmationStatus,
                          confirmations: status.confirmations!,
                          err: status.error() ?? null,
                          slot: PgCommon.bigintToInt(status.slot),
                        }
                      : null
                  ),
                },
              }
            );
          }

          case "getTransaction": {
            const [signature, options] = parsedRequest.params;
            const getTxResult = playnet.rpc.getTransaction(signature);

            const meta = getTxResult.meta();

            // web3.js expects tx object but solana-cli expects base64 encoded
            // tx string. We get base64 tx string from `playnet` and convert it
            // to `VersionedTransaction`
            let tx:
              | [string, string]
              | VersionedTransactionResponse["transaction"] = [
              getTxResult.transaction(),
              "base64",
            ];
            if (!options?.encoding) {
              let versionedTx = VersionedTransaction.deserialize(
                Uint8Array.from(utils.bytes.base64.decode(tx[0]))
              );
              let signatures = [];
              for (const signatureBytes of versionedTx.signatures) {
                signatures.push(utils.bytes.bs58.encode(signatureBytes));
              }

              tx = {
                message: versionedTx.message,
                signatures,
              };
            }

            const convertBalances = (bigintBalances: BigUint64Array) => {
              const balances = [];
              for (const i in bigintBalances) {
                balances.push(PgCommon.bigintToInt(bigintBalances[i]));
              }

              return balances;
            };

            return this._createRpcResponse<"getTransaction">(
              parsedRequest,
              context,
              {
                // @ts-ignore
                result: getTxResult.exists()
                  ? {
                      slot,
                      transaction: tx,
                      meta: {
                        fee: PgCommon.bigintToInt(meta.fee()),
                        innerInstructions: meta.innerInstructions(),
                        preBalances: convertBalances(meta.preBalances()),
                        postBalances: convertBalances(meta.postBalances()),
                        logMessages: meta.logs(),
                        preTokenBalances: meta.preTokenBalances(),
                        postTokenBalances: meta.postTokenBalances(),
                        err: meta.err() ?? null,
                        loadedAddresses: meta.loadedAddresses(),
                        computeUnitsConsumed: PgCommon.bigintToInt(
                          meta.computeUnitsConsumed()
                        ),
                        // @ts-ignore
                        rewards: [],
                        status: meta.err() ? { Err: meta.err() } : { Ok: null },
                      },
                      blockTime: PgCommon.bigintToInt(getTxResult.blockTime()),
                      version: getTxResult.version() ?? "legacy",
                    }
                  : null,
              }
            );
          }

          case "requestAirdrop": {
            const [address, lamports] = parsedRequest.params;
            const airdropResult = playnet.rpc.requestAirdrop(
              address,
              BigInt(lamports)
            );
            this._handleError(airdropResult);

            return this._createRpcResponse<"requestAirdrop">(
              parsedRequest,
              context,
              {
                result: airdropResult.txHash(),
              }
            );
          }

          default: {
            throw new Error(
              `Method: '${parsedRequest.method}' is not yet implemented.`
            );
          }
        }
      }

      // For every URL other than `Endpoint.PLAYNET`
      return await defaultFetch(...args);
    };
  }

  /**
   * Dispatch a custom event that sets the `fetch` function that `ConnectionProvider`
   * utilizes
   *
   * @param newFetch new `fetch` function to set
   */
  private static _setCustomFetch(
    newFetch: PgSet<{ fetch: typeof window["fetch"] }>
  ) {
    PgCommon.createAndDispatchCustomEvent(
      EventName.PLAYNET_FETCH_SET,
      newFetch
    );
  }

  /**
   * Get whether the given url belong to Playnet
   *
   * @param url URL to compare with playnet
   * @returns whether the given URL belong to Playnet
   */
  private static _isUrlPlaynet(url: string) {
    return url.startsWith(Endpoint.PLAYNET);
  }

  /**
   * Create `web3.js` compatible responses with type safety
   */
  private static _createRpcResponse<K extends keyof Connection>(
    request: RpcRequest,
    context: RpcResponseWithContext<K>["result"]["context"],
    data: {
      result?: RpcResponse<K>["result"];
      value?: RpcResponseWithContext<K>["result"]["value"];
    }
  ) {
    const responseBody: RpcResponse<K> | RpcResponseWithContext<K> = {
      id: request.id,
      jsonrpc: request.jsonrpc,
      result:
        data.result !== undefined
          ? data.result!
          : {
              context,
              value: data.value!,
            },
    };

    // WASM URL parsing fails if the `Response.url` is empty
    return Object.defineProperty(
      new Response(JSON.stringify(responseBody)),
      "url",
      { value: Endpoint.PLAYNET }
    );
  }

  /**
   * Handle WASM errors
   *
   * @param result WASM result object that has `error()` method
   */
  private static _handleError<R extends { error: () => string | undefined }>(
    result: R
  ) {
    const error = result.error();
    if (error) {
      throw new Error(error);
    }
  }
}

const defaultFetch = fetch;
