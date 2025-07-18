import {
  SourceVerifier,
  SourceVerifyPayload,
  FiftSourceCompileResult,
  FuncSourceCompileResult,
  TactSourceCompileResult,
  TolkSourceCompileResult,
} from "./types";
import path from "path";
import tweetnacl from "tweetnacl";
import { VerifyResult, Compiler, SourceItem } from "./types";
import { Cell } from "@ton/core";
import { CodeStorageProvider } from "./ipfs-code-storage-provider";
import { sha256, random64BitNumber, getNowHourRoundedDown } from "./utils";
import { TonReaderClient } from "./ton-reader-client";
import { validateMessageCell } from "./validate-message-cell";
import { writeFile } from "fs/promises";
import {
  cellToSign,
  deploySource,
  signatureCell,
  verifierRegistryForwardMessage,
} from "./cell-builders";
import mkdirp from "mkdirp";
import { getLogger } from "./logger";

export type Base64URL = string;

const logger = getLogger("controller");

interface ControllerConfig {
  verifierId: string;
  privateKey: string;
  sourcesRegistryAddress: string;
  allowReverification: boolean;
}

export class Controller {
  private ipfsProvider: CodeStorageProvider;
  private keypair: tweetnacl.SignKeyPair;
  private VERIFIER_SHA256: Buffer;
  private config: ControllerConfig;
  private compilers: { [key in Compiler]: SourceVerifier };
  private tonReaderClient: TonReaderClient;

  constructor(
    ipfsProvider: CodeStorageProvider,
    compilers: { [key in Compiler]: SourceVerifier },
    config: ControllerConfig,
    tonReaderClient: TonReaderClient,
  ) {
    this.VERIFIER_SHA256 = sha256(config.verifierId);
    this.config = config;
    this.compilers = compilers;
    this.ipfsProvider = ipfsProvider;
    this.keypair = tweetnacl.sign.keyPair.fromSecretKey(
      Buffer.from(this.config.privateKey, "base64"),
    );

    this.tonReaderClient = tonReaderClient;
  }

  async addSource(verificationPayload: SourceVerifyPayload): Promise<VerifyResult> {
    // Compile
    const compiler = this.compilers[verificationPayload.compiler];
    const compileResult = await compiler.verify(verificationPayload);
    if (compileResult.error || compileResult.result !== "similar" || !compileResult.hash) {
      return {
        compileResult,
      };
    }

    if (!this.config.allowReverification) {
      const isDeployed = await this.tonReaderClient.isProofDeployed(
        verificationPayload.knownContractHash,
        this.config.verifierId,
      );
      if (isDeployed) {
        return {
          compileResult: {
            result: "unknown_error",
            error: "Contract is already deployed",
            hash: null,
            compilerSettings: compileResult.compilerSettings,
            sources: compileResult.sources,
          },
        };
      }
    }

    // Upload sources to IPFS
    const sourcesToUpload = compileResult.sources.map(
      (
        s:
          | FuncSourceCompileResult
          | FiftSourceCompileResult
          | TolkSourceCompileResult
          | TactSourceCompileResult,
      ) => ({
        path: path.join(verificationPayload.tmpDir, s.filename),
        name: s.filename,
      }),
    );
    const fileLocators = await this.ipfsProvider.write(sourcesToUpload, true);

    const sourceSpec: SourceItem = {
      compilerSettings: compileResult.compilerSettings,
      compiler: verificationPayload.compiler,
      hash: compileResult.hash,
      verificationDate: getNowHourRoundedDown().getTime(),
      sources: fileLocators.map((f, i) => {
        return {
          url: f,
          ...compileResult.sources[i],
        };
      }),
      knownContractAddress: verificationPayload.knownContractAddress,
    };

    // Upload source spec JSON to IPFS
    const [ipfsLink] = await this.ipfsProvider.writeFromContent(
      [Buffer.from(JSON.stringify(sourceSpec))],
      true,
    );

    logger.info(ipfsLink);

    const queryId = random64BitNumber();

    // This is the message that will be forwarded to verifier registry
    const msgToSign = cellToSign(
      verificationPayload.senderAddress,
      queryId,
      compileResult.hash!,
      ipfsLink,
      this.config.sourcesRegistryAddress,
      this.VERIFIER_SHA256,
    );

    const { sig, sigCell } = signatureCell(msgToSign, this.keypair);

    return {
      compileResult,
      sig: sig.toString("base64"),
      ipfsLink: ipfsLink,
      msgCell: verifierRegistryForwardMessage(queryId, msgToSign, sigCell),
    };
  }

  public async sign({ messageCell, tmpDir }: { messageCell: Buffer; tmpDir: string }) {
    const cell = Cell.fromBoc(Buffer.from(messageCell))[0];

    const verifierConfig = await this.tonReaderClient.getVerifierConfig(
      this.config.verifierId,
      this.config.sourcesRegistryAddress,
    );

    const { ipfsPointer, codeCellHash, senderAddress, queryId } = validateMessageCell(
      cell,
      this.VERIFIER_SHA256,
      this.config.sourcesRegistryAddress,
      this.keypair,
      verifierConfig,
    );

    const sourceTemp = await this.ipfsProvider.read(ipfsPointer);

    const json: SourceItem = JSON.parse(sourceTemp);

    if (json.hash !== codeCellHash) {
      throw new Error("Code hash mismatch");
    }

    const compiler = this.compilers[json.compiler];

    const sources = await Promise.all(
      json.sources.map(async (s) => {
        const content = await this.ipfsProvider.read(s.url);
        const filePath = path.join(tmpDir, s.filename);

        await mkdirp(filePath.substring(0, filePath.lastIndexOf("/")));
        await writeFile(filePath, content);

        return {
          ...s,
          path: s.filename,
        };
      }),
    );

    const sourceToVerify: SourceVerifyPayload = {
      sources: sources,
      compiler: json.compiler,
      compilerSettings: {
        ...json.compilerSettings,
        // TODO this is a hack because only func has a command line arg for now.
        // @ts-ignore
        commandLine: json.compilerSettings?.commandLine?.replace(/^func/, ""),
      },
      knownContractAddress: json.knownContractAddress,
      knownContractHash: json.hash,
      tmpDir: tmpDir,
      senderAddress: senderAddress.toString(),
    };

    const compileResult = await compiler.verify(sourceToVerify);

    if (compileResult.result !== "similar") {
      throw new Error("Invalid compilation result: " + compileResult.result);
    }

    const slice = cell.beginParse();
    const msgToSign = slice.loadRef();
    const { sigCell } = signatureCell(msgToSign, this.keypair);
    let updateSigCell = addSignatureCell(slice.loadRef(), sigCell);

    return {
      msgCell: slice.asBuilder().storeRef(msgToSign).storeRef(updateSigCell).asCell().toBoc(),
    };
  }
}

function addSignatureCell(node: Cell, sigCell: Cell): Cell {
  const slice = node.beginParse();
  if (slice.remainingRefs > 0) {
    const child = slice.loadRef();
    if (slice.remainingRefs > 0) {
      throw new Error("Each signature cell should have at most one ref to another sig cell");
    }

    return slice.asBuilder().storeRef(addSignatureCell(child, sigCell)).asCell();
  }

  return slice.asBuilder().storeRef(sigCell).asCell();
}
