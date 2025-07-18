import { Controller } from "../src/controller";
import { CodeStorageProvider, FileUploadSpec } from "../src/ipfs-code-storage-provider";
// @ts-ignore
import { of as ipfsHash } from "ipfs-only-hash";
import tweetnacl from "tweetnacl";
import { CompileResult, SourceVerifier, SourceVerifyPayload } from "../src/types";
import { beginCell, Cell, Address, Slice } from "@ton/core";
import { TonReaderClient, VerifierConfig } from "../src/ton-reader-client";
import { sha256 } from "../src/utils";
import Prando from "prando";
import { FORWARD_MESSAGE_OP, DEPLOY_SOURCE_OP } from "../src/cell-builders";

function randomAddress(seed: string, workchain: number = 0) {
  const random = new Prando(seed);
  const hash = Buffer.alloc(32);
  for (let i = 0; i < hash.length; i++) {
    hash[i] = random.nextInt(0, 255);
  }
  return new Address(workchain, hash);
}

const verificationDate = Math.floor(new Date().getTime() / 1000) + 60 * 10;
const emptyCellHash = new Cell().hash().toString("base64");

class StubCodeStorageProvider implements CodeStorageProvider {
  storage: Map<string, string> = new Map();

  async write(files: FileUploadSpec[], pin: boolean): Promise<string[]> {
    return Promise.all(files.map((file) => ipfsHash(file.name)));
  }

  async writeFromContent(files: Buffer[], pin: boolean): Promise<string[]> {
    const hashes = await Promise.all(files.map((file) => ipfsHash(file)));
    files.forEach((file, i) => {
      this.storage.set(hashes[i], file.toString("utf8"));
    });

    return hashes;
  }

  async read(pointer: string): Promise<string> {
    return this.storage.get(pointer)!;
  }

  clear() {
    this.storage.clear();
  }
}

class StubSourceVerifier implements SourceVerifier {
  async verify(payload: SourceVerifyPayload): Promise<CompileResult> {
    return {
      result: "similar",
      error: null,
      compilerSettings: {
        funcVersion: "0.4.0",
        commandLine: "some command line",
      },
      hash: emptyCellHash,
      sources: [],
    };
  }
}

const serverKeypair = tweetnacl.sign.keyPair();
const server2Keypair = tweetnacl.sign.keyPair();
const server3Keypair = tweetnacl.sign.keyPair();

class StubTonReaderClient implements TonReaderClient {
  async getVerifierConfig(
    verifierId: string,
    verifierRegistryAddress: string,
  ): Promise<VerifierConfig> {
    return {
      quorum: 3,
      verifiers: [
        Buffer.from(serverKeypair.publicKey),
        Buffer.from(server2Keypair.publicKey),
        Buffer.from(server3Keypair.publicKey),
      ],
    };
  }
  async isProofDeployed(codeCellHash: string, verifierId: string): Promise<boolean | undefined> {
    return false;
  }
}

const VERIFIER_ID = "some verifier";

const stubTonReaderClient = new StubTonReaderClient();
const stubSourceVerifier = new StubSourceVerifier();
const stubCodeStorageProvider = new StubCodeStorageProvider();

function makeController(keypair: tweetnacl.SignKeyPair): Controller {
  return new Controller(
    stubCodeStorageProvider,
    {
      func: stubSourceVerifier,
      fift: stubSourceVerifier,
      tact: stubSourceVerifier,
      tolk: stubSourceVerifier,
    },
    {
      privateKey: Buffer.from(keypair.secretKey).toString("base64"),
      allowReverification: false,
      sourcesRegistryAddress: randomAddress("sourcesReg").toString(),
      verifierId: VERIFIER_ID,
    },
    stubTonReaderClient,
  );
}

describe("Controller", () => {
  let controller: Controller;
  let controller2: Controller;
  let controller3: Controller;

  beforeEach(() => {
    controller = makeController(serverKeypair);
    controller2 = makeController(server2Keypair);
    controller3 = makeController(server3Keypair);

    stubCodeStorageProvider.clear();
  });

  it("Adds source", async () => {
    const result = await controller.addSource({
      compiler: "func",
      compilerSettings: {
        funcVersion: "0.4.0",
        commandLine: "", // TODO why is this mandatory
      },
      knownContractAddress: "N/A",
      knownContractHash: "SomeHASH", // TODO this should be validated
      senderAddress: randomAddress("sender").toString(), // TODO should be validated to + in the original func
      sources: [],
      tmpDir: "N/A", // TODO
    });

    expect(result.compileResult.hash).toEqual(emptyCellHash);
  });

  describe("Sign", () => {
    it("Signs a source", async () => {
      // First server signs
      const { msgCell } = await controller.addSource({
        compiler: "func",
        compilerSettings: {
          funcVersion: "0.2.0",
          commandLine: "", // TODO why is this mandatory
        },
        knownContractAddress: "N/A",
        knownContractHash: "SomeHASH", // TODO this should be validated
        senderAddress: randomAddress("sender").toString(), // TODO should be validated to + in the original func
        sources: [],
        tmpDir: "N/A", // TODO
      });

      // Second server adds signature
      const afterController2SigResult = await controller2.sign({
        messageCell: msgCell!,
        tmpDir: "",
      });
      const afterController2SigSlice = Cell.fromBoc(
        afterController2SigResult.msgCell,
      )[0].beginParse();

      // Ensure message itself is intact
      const content = afterController2SigSlice.loadRef();
      expect(content.hash()).toEqual(Cell.fromBoc(msgCell!)[0].asSlice().loadRef().hash());

      // Ensure signature 1 remains included
      const server1SigSlice = afterController2SigSlice.loadRef().beginParse();
      expect(server1SigSlice.skip(512).loadBuffer(32)).toEqual(
        Buffer.from(serverKeypair.publicKey),
      );

      // Ensure signature 2 was added
      const server2SigSlice = server1SigSlice.loadRef().beginParse();
      expect(server2SigSlice.skip(512).loadBuffer(32)).toEqual(
        Buffer.from(server2Keypair.publicKey),
      );

      // Third server adds signature
      const afterController3SigResult = await controller3.sign({
        messageCell: afterController2SigResult.msgCell,
        tmpDir: "",
      });
      const afterController3SigSlice = Cell.fromBoc(
        afterController3SigResult.msgCell,
      )[0].beginParse();

      // Ensure message itself is intact
      const content2 = afterController3SigSlice.loadRef();
      expect(content2.hash()).toEqual(Cell.fromBoc(msgCell!)[0].asSlice().loadRef().hash());

      // Ensure signature 1 remains included
      const server1SigSlice2 = afterController3SigSlice.loadRef().beginParse();
      expect(server1SigSlice2.skip(512).loadBuffer(32)).toEqual(
        Buffer.from(serverKeypair.publicKey),
      );

      // Ensure signature 2 remains included
      const server2SigSlice2 = server1SigSlice2.loadRef().beginParse();
      expect(server2SigSlice2.skip(512).loadBuffer(32)).toEqual(
        Buffer.from(server2Keypair.publicKey),
      );

      // Ensure signature 3 was added
      const server3SigSlice = server2SigSlice2.loadRef().beginParse();
      expect(server3SigSlice.skip(512).loadBuffer(32)).toEqual(
        Buffer.from(server3Keypair.publicKey),
      );
    });

    describe("Invalid wrapper cell", () => {
      Object.entries({
        "invalid op": {
          cell: beginCell()
            .storeUint(1, 32)
            .storeUint(0, 64)
            .storeRef(new Cell())
            .storeRef(new Cell())
            .endCell()
            .toBoc(),
          error: "Invalid operation",
        },
        "no query id": {
          cell: beginCell()
            .storeUint(FORWARD_MESSAGE_OP, 32)
            .storeRef(new Cell())
            .storeRef(new Cell())
            .endCell()
            .toBoc(),
          error: "Invalid cell",
        },
        "no refs": {
          cell: beginCell().storeUint(1, 32).storeUint(0, 64).endCell().toBoc(),
          error: "Invalid cell",
        },
        "empty cell": {
          cell: new Cell().toBoc(),
          error: "Invalid cell",
        },
      }).map(([name, config]) => {
        const { error, cell } = config;
        it(`Rejects: ${name}`, async () => {
          await expect(controller.sign({ messageCell: cell, tmpDir: "" })).rejects.toThrow(error);
        });
      });
    });

    describe("Invalid verifier message cell", () => {
      Object.entries({
        "different verifier id": {
          cell: beginCell()
            .storeUint(FORWARD_MESSAGE_OP, 32)
            .storeUint(0, 64)
            .storeRef(
              beginCell()
                .storeBuffer(sha256("some other verifier"))
                .storeUint(1, 32)
                .storeAddress(Address.parse(zeroAddress()))
                .storeAddress(randomAddress("sourcesReg"))
                .storeRef(new Cell())
                .endCell(),
            )
            .storeRef(new Cell())
            .endCell()
            .toBoc(),
          error: "Invalid verifier id",
        },
        expired: {
          cell: beginCell()
            .storeUint(FORWARD_MESSAGE_OP, 32)
            .storeUint(0, 64)
            .storeRef(
              beginCell()
                .storeBuffer(sha256(VERIFIER_ID))
                .storeUint(Math.floor(Date.now() / 1000) - 60 * 5, 32) // Message was valid up until 5 minutes ago
                .storeAddress(Address.parse(zeroAddress()))
                .storeAddress(randomAddress("sourcesReg"))
                .storeRef(new Cell())
                .endCell(),
            )
            .storeRef(new Cell())
            .endCell()
            .toBoc(),
          error: "Message is expired",
        },
        "invalid sources registry": {
          cell: beginCell()
            .storeUint(FORWARD_MESSAGE_OP, 32)
            .storeUint(0, 64)
            .storeRef(
              beginCell()
                .storeBuffer(sha256(VERIFIER_ID))
                .storeUint(Math.floor(Date.now() / 1000) + 60 * 5, 32)
                .storeAddress(Address.parse(zeroAddress()))
                .storeAddress(randomAddress("notSourcesReg"))
                .storeRef(new Cell())
                .endCell(),
            )
            .storeRef(new Cell())
            .endCell()
            .toBoc(),
          error: "Invalid sources registry address",
        },
        "missing ref": {
          cell: beginCell()
            .storeUint(FORWARD_MESSAGE_OP, 32)
            .storeUint(0, 64)
            .storeRef(
              beginCell()
                .storeBuffer(sha256(VERIFIER_ID))
                .storeUint(Math.floor(Date.now() / 1000) + 60 * 5, 32)
                .storeAddress(Address.parse(zeroAddress()))
                .storeAddress(randomAddress("sourcesReg"))
                .endCell(),
            )
            .storeRef(new Cell())
            .endCell()
            .toBoc(),
          error: "Invalid verifier body cell",
        },
        "missing addresses": {
          cell: beginCell()
            .storeUint(FORWARD_MESSAGE_OP, 32)
            .storeUint(0, 64)
            .storeRef(
              beginCell()
                .storeBuffer(sha256(VERIFIER_ID))
                .storeUint(Math.floor(Date.now() / 1000) + 60 * 5, 32)
                .storeRef(new Cell())
                .endCell(),
            )
            .storeRef(new Cell())
            .endCell()
            .toBoc(),
          error: "Invalid verifier body cell",
        },
      }).map(([name, config]) => {
        const { error, cell } = config;
        it(`Rejects: ${name}`, async () => {
          await expect(controller.sign({ messageCell: cell, tmpDir: "" })).rejects.toThrow(error);
        });
      });
    });

    describe("Invalid sources registry message", () => {
      const validWrappingCell = (sourceRegCell: Cell) =>
        beginCell()
          .storeUint(FORWARD_MESSAGE_OP, 32)
          .storeUint(0, 64)
          .storeRef(
            beginCell()
              .storeBuffer(sha256(VERIFIER_ID))
              .storeUint(Math.floor(Date.now() / 1000) + 60 * 5, 32)
              .storeAddress(Address.parse(zeroAddress()))
              .storeAddress(randomAddress("sourcesReg"))
              .storeRef(sourceRegCell)
              .endCell(),
          )
          .storeRef(new Cell())
          .endCell();

      Object.entries({
        "empty cell": {
          cell: validWrappingCell(new Cell()).toBoc(),
          error: "Invalid sources registry body cell",
        },
        "missing ref": {
          cell: validWrappingCell(
            beginCell()
              .storeUint(1, 32)
              .storeUint(0, 64)
              .storeUint(0, 256)
              .storeUint(0, 256)
              .endCell(),
          ).toBoc(),
          error: "Invalid sources registry body cell",
        },
        "invalid op": {
          cell: validWrappingCell(
            beginCell()
              .storeUint(1, 32)
              .storeUint(0, 64)
              .storeBuffer(sha256(VERIFIER_ID))
              .storeUint(0, 256)
              .storeRef(new Cell())
              .endCell(),
          ).toBoc(),
          error: "Invalid deploy source op",
        },
        "invalid verified id": {
          cell: validWrappingCell(
            beginCell()
              .storeUint(DEPLOY_SOURCE_OP, 32)
              .storeUint(0, 64)
              .storeBuffer(sha256("not verifier id"))
              .storeUint(0, 256)
              .storeRef(new Cell())
              .endCell(),
          ).toBoc(),
          error: "Invalid verifier id",
        },
      }).map(([name, config]) => {
        const { error, cell } = config;
        it(`Rejects: ${name}`, async () => {
          await expect(controller.sign({ messageCell: cell, tmpDir: "" })).rejects.toThrow(error);
        });
      });
    });

    function makeSigCell(cellToSign: Cell, kp: tweetnacl.SignKeyPair) {
      const sig = Buffer.from(tweetnacl.sign.detached(cellToSign.hash(), kp.secretKey));
      return beginCell().storeBuffer(sig).storeBuffer(Buffer.from(kp.publicKey)).endCell();
    }

    describe("Invalid signatures", () => {
      const cellToSign = beginCell()
        .storeBuffer(sha256(VERIFIER_ID))
        .storeUint(Math.floor(Date.now() / 1000) + 60 * 5, 32)
        .storeAddress(Address.parse(zeroAddress()))
        .storeAddress(randomAddress("sourcesReg"))
        .storeRef(
          beginCell()
            .storeUint(DEPLOY_SOURCE_OP, 32)
            .storeUint(0, 64)
            .storeBuffer(sha256(VERIFIER_ID))
            .storeUint(0, 256)
            .storeRef(beginCell().storeUint(1, 8).storeBuffer(Buffer.from("someLink")).endCell())
            .endCell(),
        )
        .endCell();

      const validWrappingCell = (signCell: Cell) =>
        beginCell()
          .storeUint(FORWARD_MESSAGE_OP, 32)
          .storeUint(0, 64)
          .storeRef(cellToSign)
          .storeRef(signCell)
          .endCell();

      async function expectSignThrow(signCell: Cell, error: string) {
        await expect(
          controller.sign({ messageCell: validWrappingCell(signCell).toBoc(), tmpDir: "" }),
        ).rejects.toThrow(error);
      }

      describe("Invalid signature cell", () => {
        it("Empty", async () => {
          await expectSignThrow(new Cell(), "Invalid signature cell");
        });

        it("Non-Empty", async () => {
          await expectSignThrow(beginCell().storeUint(0, 1).endCell(), "Invalid signature cell");
        });

        it("Invalid signing public key", async () => {
          const kp = tweetnacl.sign.keyPair();
          const kp2 = tweetnacl.sign.keyPair();
          const sig = Buffer.from(tweetnacl.sign.detached(cellToSign.hash(), kp2.secretKey));

          const sigCell = beginCell()
            .storeBuffer(sig)
            .storeBuffer(Buffer.from(kp.publicKey))
            .endCell();

          await expectSignThrow(sigCell, "Invalid signature");
        });

        it("Invalid signed cell hash", async () => {
          const kp = tweetnacl.sign.keyPair();
          const sig = Buffer.from(tweetnacl.sign.detached(new Cell().hash(), kp.secretKey));

          const sigCell = beginCell()
            .storeBuffer(sig)
            .storeBuffer(Buffer.from(kp.publicKey))
            .endCell();

          await expectSignThrow(sigCell, "Invalid signature");
        });

        it("Multiple signatures, one invalid", async () => {
          const kp = tweetnacl.sign.keyPair();
          const kp2 = tweetnacl.sign.keyPair();

          const mock = jest.spyOn(stubTonReaderClient, "getVerifierConfig").mockResolvedValue({
            quorum: 3,
            verifiers: [
              Buffer.from(serverKeypair.publicKey),
              Buffer.from(kp.publicKey),
              Buffer.from(kp2.publicKey),
            ],
          });

          let sigCell = makeSigCell(cellToSign, kp2);
          sigCell = sigCell.asBuilder().storeRef(makeSigCell(new Cell(), kp)).asCell();

          await expectSignThrow(sigCell, "Invalid signature");
          mock.mockRestore();
        });

        it("Sig cell contains more than one ref", async () => {
          const kp = tweetnacl.sign.keyPair();
          const kp2 = tweetnacl.sign.keyPair();

          const mock = jest.spyOn(stubTonReaderClient, "getVerifierConfig").mockResolvedValue({
            quorum: 3,
            verifiers: [
              Buffer.from(serverKeypair.publicKey),
              Buffer.from(kp.publicKey),
              Buffer.from(kp2.publicKey),
            ],
          });

          const sigBuilder = makeSigCell(cellToSign, kp2).asBuilder();
          sigBuilder.storeRef(makeSigCell(cellToSign, kp));
          sigBuilder.storeRef(makeSigCell(cellToSign, kp));

          await expectSignThrow(sigBuilder.asCell(), "Invalid signature cell");
          mock.mockRestore();
        });
      });

      it("Already signed by own", async () => {
        const kp = tweetnacl.sign.keyPair();
        const mock = jest.spyOn(stubTonReaderClient, "getVerifierConfig").mockResolvedValue({
          quorum: 2,
          verifiers: [Buffer.from(serverKeypair.publicKey), Buffer.from(kp.publicKey)],
        });

        await expectSignThrow(
          makeSigCell(cellToSign, serverKeypair),
          "Invalid signature (signed by self)",
        );
        mock.mockRestore();
      });

      it("Sig does not belong to verifier id", async () => {
        const [kp, kp2, kp3] = [
          tweetnacl.sign.keyPair(),
          tweetnacl.sign.keyPair(),
          tweetnacl.sign.keyPair(),
        ];

        const mock = jest.spyOn(stubTonReaderClient, "getVerifierConfig").mockResolvedValue({
          quorum: 2,
          verifiers: [
            Buffer.from(kp.publicKey),
            Buffer.from(kp2.publicKey),
            Buffer.from(kp3.publicKey),
          ],
        });

        const sigCell = makeSigCell(cellToSign, kp);
        await expectSignThrow(sigCell, "This verifier is not in the multisig config");

        mock.mockRestore();
      });

      it("Only one in quorum", async () => {
        const kp = tweetnacl.sign.keyPair();
        const mock = jest.spyOn(stubTonReaderClient, "getVerifierConfig").mockResolvedValue({
          quorum: 1,
          verifiers: [Buffer.from(serverKeypair.publicKey)],
        });

        const sigCell = makeSigCell(cellToSign, kp);
        await expectSignThrow(sigCell, "Mulisig quorum must be greater than 1");

        mock.mockRestore();
      });

      it("More signatures than need", async () => {
        const kp = tweetnacl.sign.keyPair();
        const kp2 = tweetnacl.sign.keyPair();
        const mock = jest.spyOn(stubTonReaderClient, "getVerifierConfig").mockResolvedValue({
          quorum: 2,
          verifiers: [
            Buffer.from(serverKeypair.publicKey),
            Buffer.from(kp.publicKey),
            Buffer.from(kp2.publicKey),
          ],
        });

        let sigCell = makeSigCell(cellToSign, kp);
        const sigCell2 = makeSigCell(cellToSign, kp2);
        sigCell = sigCell.asBuilder().storeRef(sigCell2).asCell();
        await expectSignThrow(sigCell, "Too many signatures");

        mock.mockRestore();
      });

      it("Signature appears more than once", async () => {
        const kp = tweetnacl.sign.keyPair();
        const kp2 = tweetnacl.sign.keyPair();
        const mock = jest.spyOn(stubTonReaderClient, "getVerifierConfig").mockResolvedValue({
          quorum: 3,
          verifiers: [
            Buffer.from(serverKeypair.publicKey),
            Buffer.from(kp.publicKey),
            Buffer.from(kp2.publicKey),
          ],
        });

        let sigCell = makeSigCell(cellToSign, kp);
        const sigCell2 = makeSigCell(cellToSign, kp);
        sigCell = sigCell.asBuilder().storeRef(sigCell2).asCell();
        await expectSignThrow(sigCell, "Duplicate signature");

        mock.mockRestore();
      });
    });

    describe("Invalid compilation results", () => {
      const cellToSign = beginCell()
        .storeBuffer(sha256(VERIFIER_ID))
        .storeUint(verificationDate, 32)
        .storeAddress(Address.parse(zeroAddress()))
        .storeAddress(randomAddress("sourcesReg"))
        .storeRef(
          beginCell()
            .storeUint(DEPLOY_SOURCE_OP, 32)
            .storeUint(0, 64)
            .storeBuffer(sha256(VERIFIER_ID))
            .storeBuffer(new Cell().hash()) // code cell hash
            .storeRef(beginCell().storeUint(1, 8).storeBuffer(Buffer.from("someLink")).endCell())
            .endCell(),
        )
        .endCell();

      const validWrappingCell = beginCell()
        .storeUint(FORWARD_MESSAGE_OP, 32)
        .storeUint(0, 64)
        .storeRef(cellToSign)
        .storeRef(makeSigCell(cellToSign, server2Keypair))
        .endCell();

      it("Different code hash", async () => {
        const mock = jest.spyOn(stubSourceVerifier, "verify").mockResolvedValue({
          result: "not_similar",
          error: null,
          compilerSettings: {
            funcVersion: "0.3.0",
            commandLine: "some command line",
          },
          hash: emptyCellHash,
          sources: [],
        });

        stubCodeStorageProvider.storage.set(
          "someLink",
          JSON.stringify({ hash: emptyCellHash, sources: [], compiler: "func" }),
        );

        await expect(
          controller.sign({ messageCell: validWrappingCell.toBoc(), tmpDir: "" }),
        ).rejects.toThrow("Invalid compilation result");

        mock.mockRestore();
      });

      it("Does not compile", async () => {
        const mock = jest.spyOn(stubSourceVerifier, "verify").mockResolvedValue({
          result: "compile_error",
          error: "some error",
          compilerSettings: {
            funcVersion: "0.3.0",
            commandLine: "some command line",
          },
          hash: emptyCellHash,
          sources: [],
        });

        stubCodeStorageProvider.storage.set(
          "someLink",
          JSON.stringify({ hash: emptyCellHash, sources: [], compiler: "func" }),
        );

        await expect(
          controller.sign({ messageCell: validWrappingCell.toBoc(), tmpDir: "" }),
        ).rejects.toThrow("Invalid compilation result");

        mock.mockRestore();
      });
    });
  });
});

function zeroAddress(): string {
  return "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
}
