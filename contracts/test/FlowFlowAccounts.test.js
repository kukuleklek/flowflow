const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("FlowFlowAccountFactory", () => {
  async function setup() {
    const [admin, recorder, user, other] = await ethers.getSigners();
    const f = await (await ethers.getContractFactory("FlowFlowAccountFactory")).deploy(recorder.address);
    return { f, admin, recorder, user, other };
  }
  const H = (s) => ethers.id(s);

  it("records a withdrawal only from the recorder, makes the account at the predicted address, never twice", async () => {
    const { f, recorder, user, other } = await setup();
    const predicted = await f.predictAccount(user.address);
    await expect(f.connect(other).recordWithdraw(user.address, 5_090_000n, 42161n, H("a"), false)).to.be.revertedWithCustomError(f, "NotRecorder");
    await expect(f.connect(recorder).recordWithdraw(user.address, 5_090_000n, 42161n, H("a"), false))
      .to.emit(f, "AccountCreated").withArgs(user.address, predicted)
      .and.to.emit(f, "WithdrawRecorded").withArgs(user.address, predicted, 5_090_000n, 42161n, H("a"), false);
    await expect(f.connect(recorder).recordWithdraw(user.address, 1n, 42161n, H("a"), false)).to.be.revertedWithCustomError(f, "AlreadyRecorded");
    await f.connect(recorder).recordWithdraw(user.address, 2_000_000n, 43114n, H("b"), true);
    expect(await f.accountOf(user.address)).to.equal(predicted);
    expect(await f.withdrawCount(user.address)).to.equal(2n);
    expect(await f.withdrawnUsdc(user.address)).to.equal(7_090_000n);
    expect([await f.totalAccounts(), await f.totalWithdrawals(), await f.totalWithdrawnUsdc()]).to.deep.equal([1n, 2n, 7_090_000n]);
    const acct = await ethers.getContractAt("FlowFlowAccount", predicted);
    expect([await acct.owner(), await acct.factory()]).to.deep.equal([user.address, await f.getAddress()]);
  });

  it("a user can make their own account once; the account takes no AVAX", async () => {
    const { f, user } = await setup();
    await f.connect(user).createAccount();
    await f.connect(user).createAccount();
    expect(await f.totalAccounts()).to.equal(1n);
    await expect(user.sendTransaction({ to: await f.accountOf(user.address), value: 1n })).to.be.reverted;
  });

  it("only the admin changes the recorder", async () => {
    const { f, admin, other } = await setup();
    await expect(f.connect(other).setRecorder(other.address)).to.be.revertedWithCustomError(f, "NotAdmin");
    await f.connect(admin).setRecorder(other.address);
    expect(await f.recorder()).to.equal(other.address);
  });
});
