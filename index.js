require("dotenv").config();
const axios = require("axios").default;
const Web3 = require("web3");
const fs = require("fs");
const { pick, pickBy } = require("ramda");
const { inspect } = require("util");

// Can be overridden by command line arguments
const MODULE = "TransferManager";
const VERSION = "1.6.0";
const WALLET = "0xc4d46ecbc83f41d0bf71a39868d3f830299068b8";
const METHOD = "addModule";
const FROM_BLOCK = "10000000";
const TO_BLOCK = "20000000";

const web3 = new Web3(new Web3.providers.HttpProvider(`https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`));

function parseCommandLineArgs() {
  let idx;
  idx = process.argv.indexOf("--module");
  const moduleName = idx > -1 ? process.argv[idx + 1] : MODULE;
  idx = process.argv.indexOf("--wallet");
  const wallet = idx > -1 ? process.argv[idx + 1] : WALLET;
  idx = process.argv.indexOf("--version");
  const version = idx > -1 ? process.argv[idx + 1] : VERSION;
  idx = process.argv.indexOf("--method");
  const method = idx > -1 ? process.argv[idx + 1] : METHOD;
  idx = process.argv.indexOf("--from");
  const fromBlock = idx > -1 ? process.argv[idx + 1] : FROM_BLOCK;
  idx = process.argv.indexOf("--to");
  const toBlock = idx > -1 ? process.argv[idx + 1] : TO_BLOCK;
  return { moduleName, wallet, version, method, fromBlock, toBlock };
}

async function getModuleAddress(moduleName, version) {
  const { versions } = (
    await axios
      .create({
        baseURL: process.env.MODULE_ENDPOINT,
        timeout: 10000,
      })
      .get()
  ).data;
  return versions.find((v) => v.version === version).modules.find((m) => m.name === moduleName).address;
}

function decimalizeValues(log) {
  const toDecimalize = pick(["timeStamp", "blockNumber", "gasPrice", "gasUsed", "logIndex", "transactionIndex"], log);
  const decimalized = Object.fromEntries(Object.entries(toDecimalize).map(([k, v]) => [k, parseInt(web3.utils.hexToNumberString(v))]));
  return decimalized;
}

async function getFunctionInfo(log, abi) {
  const { input } = await web3.eth.getTransaction(log.transactionHash);
  const fun = decodeInput(input, abi);
  if (fun && fun.funName === "execute") {
    const subfun = decodeInput(fun.funInput._data, abi);
    if (subfun) {
      fun.subFunName = subfun.funName;
      fun.subFunInput = subfun.funInput;
    }
    fun.success = parseInt(web3.utils.hexToNumberString(log.topics[2]));
  }
  return fun;
}

function decodeInput(input, abi) {
  const fun = abi.find((e) => web3.eth.abi.encodeFunctionSignature(e) === input.slice(0, 10));
  if (fun) {
    const decodedInput = web3.eth.abi.decodeParameters(fun.inputs, input.slice(10));
    const cleanedInput = pickBy((val, key) => key !== "__length__" && isNaN(parseInt(key)), { ...decodedInput });
    return { funName: fun.name, funInput: cleanedInput };
  }
  return null;
}

function decodeTopics(log, abi) {
  const eventAbi = abi.find((e) => e.type === "event" && web3.eth.abi.encodeEventSignature(e) === log.topics[0]);
  const decoded = web3.eth.abi.decodeLog(eventAbi.inputs, log.data, log.topics);
  const cleaned = pickBy((val, key) => key !== "__length__" && isNaN(parseInt(key)), { ...decoded });
  return { event: { name: eventAbi.name, ...cleaned } };
}

async function main() {
  const { moduleName, wallet, version, method, fromBlock, toBlock } = parseCommandLineArgs();

  const moduleAddress = await getModuleAddress(moduleName, version);
  const moduleAbi = JSON.parse(fs.readFileSync(`${__dirname}/abi/${version}/${moduleName}.json`)).abi;

  const logs = (
    await axios
      .create({
        baseURL: "https://api.etherscan.io",
        timeout: 10000,
      })
      .get("/api", {
        params: {
          module: "logs",
          action: "getLogs",
          apikey: process.env.ETHERSCAN_API_KEY,
          fromBlock: fromBlock,
          toBlock: toBlock,
          address: moduleAddress,
          topic1: web3.utils.padLeft(wallet, 64),
        },
      })
  ).data.result;

  const decodedLogs = await Promise.all(
    logs.map(async (log) => {
      const functionInfo = await getFunctionInfo(log, moduleAbi);
      const decimalized = decimalizeValues(log);
      const decodedTopics = decodeTopics(log, moduleAbi);
      return { ...log, ...decodedTopics, ...functionInfo, ...decimalized };
    })
  );
  const filteredLogs = decodedLogs.filter((e) => !method || method.length === 0 || e.subFunName === method || e.funName === method);

  console.log(inspect(filteredLogs, { colors: true, depth: 2 }));
}

main();
