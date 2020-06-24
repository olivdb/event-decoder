// Usage: node index.js

require("dotenv").config();
const axios = require("axios").default;
const Web3 = require("web3");
const fs = require("fs");
const { pick, pickBy } = require("ramda");
const { inspect } = require("util");

const MODULE = "TransferManager";
// const VERSION = "1.4.5";
const VERSION = "1.6.0";
const WALLET = "0xc4d46ecbc83f41d0bf71a39868d3f830299068b8";
const METHOD = "addModule";

const web3 = new Web3(new Web3.providers.HttpProvider(`https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`));
const transferMgrAbi = JSON.parse(fs.readFileSync(`${__dirname}/abi/${VERSION}/${MODULE}.json`)).abi;

function decodeInput(input, abi = transferMgrAbi) {
  const fun = abi.find((e) => web3.eth.abi.encodeFunctionSignature(e) === input.slice(0, 10));
  if (fun) {
    const decodedInput = web3.eth.abi.decodeParameters(fun.inputs, input.slice(10));
    const cleanedInput = pickBy((val, key) => key !== "__length__" && isNaN(parseInt(key)), { ...decodedInput });
    return { funName: fun.name, funInput: cleanedInput };
  }
  return null;
}

async function getModuleAddress(moduleName, version) {
  const backend = axios.create({
    baseURL: process.env.MODULE_ENDPOINT,
    timeout: 10000,
  });
  const { versions } = (await backend.get()).data;
  return versions.find((v) => v.version === version).modules.find((m) => m.name === moduleName).address;
}

async function getFunctionInfo(log) {
  const { input } = await web3.eth.getTransaction(log.transactionHash);
  const fun = decodeInput(input);
  if (fun && fun.funName === "execute") {
    const subfun = decodeInput(fun.funInput._data);
    if (subfun) {
      fun.subFunName = subfun.funName;
      fun.subFunInput = subfun.funInput;
    }
    fun.success = parseInt(web3.utils.hexToNumberString(log.topics[2]));
  }
  return fun;
}

function decimalizeValues(log) {
  const toDecimalize = pick(["timeStamp", "blockNumber", "gasPrice", "gasUsed", "logIndex", "transactionIndex"], log);
  const decimalized = Object.fromEntries(Object.entries(toDecimalize).map(([k, v]) => [k, parseInt(web3.utils.hexToNumberString(v))]));
  return decimalized;
}

function decodeTopics(log, abi = transferMgrAbi) {
  const eventAbi = abi.find((e) => e.type === "event" && web3.eth.abi.encodeEventSignature(e) === log.topics[0]);
  const decoded = web3.eth.abi.decodeLog(eventAbi.inputs, log.data, log.topics);
  const cleaned = pickBy((val, key) => key !== "__length__" && isNaN(parseInt(key)), { ...decoded });
  return { event: { name: eventAbi.name, ...cleaned } };
}

async function main() {
  const moduleAddress = await getModuleAddress(MODULE, VERSION);
  const etherscan = axios.create({
    baseURL: "https://api.etherscan.io",
    timeout: 10000,
  });

  const logs = (
    await etherscan.get("/api", {
      params: {
        module: "logs",
        action: "getLogs",
        apikey: process.env.ETHERSCAN_API_KEY,
        fromBlock: "10320000",
        toBlock: "21000000",
        address: moduleAddress,
        topic1: web3.utils.padLeft(WALLET, 64),
      },
    })
  ).data.result;

  const decoded = await Promise.all(
    logs.map(async (log) => {
      const fun = await getFunctionInfo(log);
      const decimalized = decimalizeValues(log);
      const decodedTopics = decodeTopics(log);
      return { ...log, ...decodedTopics, ...fun, ...decimalized };
    })
  );
  const filtered = decoded.filter((e) => e.subFunName === METHOD || e.funName === METHOD);
  console.log(inspect(filtered, { colors: true, depth: 2 }));
}

main();
