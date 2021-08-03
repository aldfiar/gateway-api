// Example: https://github.com/balancer-labs/balancer-sor/blob/master/test/multihop-sor.spec.ts
import YAML from 'yaml';
import fs from 'fs';
import axios from 'axios';
import https from 'https';
import { assert } from 'chai';

const GlobalConfigFilePath = 'conf/global_conf.yml'; // assume run from root dir
const file = fs.readFileSync(GlobalConfigFilePath, 'utf8');
const config = YAML.parseDocument(file);

const tokens = ["WETH", "DAI"];
const privateKey = config.get('PRIVATE_KEY');


function sleep(ms) {
	  return new Promise(resolve => setTimeout(resolve, ms));
}

const httpsAgent = axios.create({
  httpsAgent: new https.Agent({
    ca: fs.readFileSync(config.get('CERT_PATH') + "/ca_cert.pem"),
    cert: fs.readFileSync(config.get('CERT_PATH') + "/client_cert.pem"),
    key: fs.readFileSync(config.get('CERT_PATH') + "/client_key.pem"),
    rejectUnauthorized: true
  })
});

async function request(method, path, params) {
  try {
    let response;
    const gatewayAddress = "https://localhost:5000";
    if (method === "get") {
      response = await httpsAgent.get(gatewayAddress + path, {params: params});
    } else { // post
      params["privateKey"] = privateKey;
      response = await httpsAgent.post(gatewayAddress + path, params);
    }
    return response.data;
  } catch (err) {
    // console.log(`${path} - ${err}`)
  }
}

async function ethTests() {
  console.log(tokens);
	assert.isAtLeast(tokens.length, 2,  "Pls provise atlease 2 tokens");
  assert.exists(privateKey, "Pls include PRIVATE_KEY in conf file");

  // call /
  const result = await request("get", "/", {});
  // confirm expected response
  console.log(result)
  assert.equal(result, "ok")


  // call /balances
  const balancesResponse = await request("post", "/eth/balances", {tokenList: JSON.stringify(tokens)});
  // confirm and save balances
  // console.log(balancesResponse)
  const balances = balancesResponse.balances;
  assert.isAbove(parseFloat(balances.ETH), 0, "Pls ensure there is some native token");

  // call /balances with invalid token symbol
  // confirm expected error message
  const balancesResponse1 = await request("post", "/eth/balances", {tokenList: JSON.stringify(["ABC", "XYZ"])});
  assert.isNaN(parseFloat(balancesResponse1.balances.ABC), "ABC is a valid token.");
  assert.isNaN(parseFloat(balancesResponse1.balances.XYZ), "XYZ is a valid token.");

  // call /allowances
  // confirm and save allowances
  const allowancesResponse1 = await request("post", "/eth/allowances", {tokenList: JSON.stringify(tokens), connector: "uniswap"});
  // console.log(allowancesResponse1);
  let allowances = allowancesResponse1.approvals;

  for (let token of tokens){
  	if (parseFloat(allowances[token]) < 1000.0) {
 		// call /approve on each token
  		let approve1 = await request("post", "/eth/approve", {token: token, connector: "uniswap", amount: '5000'});
  		console.log(approve1);
  		while (allowances[token] !== approve1.amount) {
  			console.log("Waiting for atleast 1 block time to give time for approval to be mined.");
			await sleep(13000);
			// confirm that allowance changed correctly
  			let allowancesResponse2 = await request("post", "/eth/allowances", {tokenList: JSON.stringify(tokens), connector: "uniswap"});
			allowances = allowancesResponse2.approvals;
		}
	}
  }

  // call /approve with invalid spender address
  const approve3 = await request("post", "/eth/approve", {token: tokens[0], connector: "nill"});
  // confirm expected error message
  assert.notExists(approve3);

  // call /approve with invalid token symbol
  const approve4 = await request("post", "/eth/approve", {token: "ABC", connector: "uniswap"});
  // confirm expected error message
  assert.notExists(approve4);

  // call /approve with invalid amount
  const approve5 = await request("post", "/eth/approve", {token: tokens[0], connector: "uniswap", amount: 'number'});
  // confirm expected error message
  assert.notExists(approve5);
}

async function unitTests() {
  // call /start
  let pair = `${tokens[0]}-${tokens[1]}`;
  const start = await request("get", "/eth/uniswap/start", {pairs: JSON.stringify([pair])});
  // call /gas-limit
  const gasLimit = await request("post", "/eth/uniswap/gas-limit", {});

  // price buy
  const buyPrice = await request("post", "/eth/uniswap/price", {base: tokens[0], quote: tokens[1], amount: '1', side:
  'buy'});

  // price sell
  const sellPrice = await request("post", "/eth/uniswap/price", {base: tokens[0], quote: tokens[1], amount: '1', side:
  'sell'});

  // trade buy
  const buy = await request("post", "/eth/uniswap/trade", {base: tokens[0], quote: tokens[1], amount: '0.01', side:
  'buy', limitPrice: buyPrice.price});
  assert.hasAnyKeys(buy, ['txHash'], "Buy trade failed.");
  console.log(`Buy hash - ${buy.txHash}`);
  let done = false;
  let tx1, tx2;
  while ( !done ) {
	tx1 = await request("post", "/eth/poll", {txHash: buy.txHash});
	  console.log(tx1);
	done = tx1.confirmed;
  }
  assert.equal(tx1.receipt.status, 1, "Buy trade reverted.");

  done = false;


  // trade sell
  const sell = await request("post", "/eth/uniswap/trade", {base: tokens[0], quote: tokens[1], amount: '0.01', side:
  'sell', limitPrice: sellPrice.price});
  assert.hasAnyKeys(sell, ['txHash'], "Sell trade failed.");
  console.log(`Buy hash - ${sell.txHash}`);
  while ( !done ) {
	tx2 = await request("post", "/eth/poll", {txHash: sell.txHash});
	  console.log(tx2);
	done = tx2.confirmed;
  }
  assert.equal(tx2.receipt.status, 1, "Sell trade reverted.");


  // add tests for extreme values of limitPrice - buy and sell
  assert.notExists(await request("post", "/eth/uniswap/trade", {base: tokens[0], quote: tokens[1], amount: '1', side:
  'buy', limitPrice: buyPrice.price / 1000}));

  // add tests for extreme values of minimumSlippage
  assert.notExists(await request("post", "/eth/uniswap/trade", {base: tokens[0], quote: tokens[1], amount: '1', side:
  'sell', limitPrice: sellPrice.price * 1000}));

}


(async() => {
	await ethTests();
	await unitTests();
})();
