#!/usr/bin/env node
require("dotenv").config({ path: `${__dirname}/.env` });
const axios = require("axios").default;
const web3 = setupWeb3(require("web3"));
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
const JSON_OUTPUT = false;

function setupWeb3(Web3) {
  if (!process.env.INFURA_API_KEY) throw new Error("INFURA_API_KEY env var not set");
  return new Web3(new Web3.providers.HttpProvider(`https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`));
}

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
  idx = process.argv.indexOf("--json");
  const json = idx > -1 || JSON_OUTPUT;
  return { moduleName, wallet, version, method, fromBlock, toBlock, json };
}

async function fetchModuleAddress(moduleName, version) {
  if (!process.env.MODULE_ENDPOINT) throw new Error("MODULE_ENDPOINT env var not set");
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

async function fetchLogs(moduleAddress, wallet, fromBlock, toBlock) {
  if (!process.env.ETHERSCAN_API_KEY) throw new Error("ETHERSCAN_API_KEY env var not set");
  return (
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
    const txExecutedSig = web3.eth.abi.encodeEventSignature(abi.find((e) => e.name === "TransactionExecuted"));
    fun.success = log.topics[0] !== txExecutedSig || web3.utils.hexToNumberString(log.topics[2]) !== "0";
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
  const decoded = web3.eth.abi.decodeLog(eventAbi.inputs, log.data, log.topics.slice(1));
  const cleaned = pickBy((val, key) => key !== "__length__" && isNaN(parseInt(key)), { ...decoded });
  return { event: { name: eventAbi.name, ...cleaned } };
}

async function decodeLogs(logs, abi) {
  return await Promise.all(
    logs.map(async (log) => {
      const functionInfo = await getFunctionInfo(log, abi);
      const decimalized = decimalizeValues(log);
      const decodedTopics = decodeTopics(log, abi);
      return { ...log, ...decodedTopics, ...functionInfo, ...decimalized };
    })
  );
}

async function main() {
  const { moduleName, wallet, version, method, fromBlock, toBlock, json } = parseCommandLineArgs();

  const moduleAddress = await fetchModuleAddress(moduleName, version);
  const moduleAbi = JSON.parse(fs.readFileSync(`${__dirname}/abi/${version}/${moduleName}.json`)).abi;

  const logs = await fetchLogs(moduleAddress, wallet, fromBlock, toBlock);
  const decodedLogs = await decodeLogs(logs, moduleAbi);
  const filteredLogs = decodedLogs.filter((e) => !method || method.length === 0 || e.subFunName === method || e.funName === method);

  const output = json ? JSON.stringify(filteredLogs, null, 2) : inspect(filteredLogs, { colors: true, depth: 2 });
  console.log(output);
}

main();
