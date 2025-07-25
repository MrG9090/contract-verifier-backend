import { Address, beginCell, Cell, Contract, ContractProvider, Sender, SendMode } from "@ton/core";

export class SourceItem implements Contract {
  constructor(
    readonly address: Address,
    readonly init?: { code: Cell; data: Cell },
  ) {}

  static createFromAddress(address: Address) {
    return new SourceItem(address);
  }

  async sendInternalMessage(provider: ContractProvider, via: Sender, body: Cell, value: bigint) {
    await provider.internal(via, {
      value: value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: body,
    });
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().endCell(),
    });
  }

  async getData(provider: ContractProvider): Promise<{ verifierId: bigint; data: Cell | null }> {
    const result = await provider.get("get_source_item_data", []);
    const verifierId = result.stack.readBigNumber();
    result.stack.skip(2);
    return { verifierId, data: result.stack.readCellOpt() };
  }
}
