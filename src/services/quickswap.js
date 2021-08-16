import {logger} from './logger';

const debug = require('debug')('router');
const math = require('mathjs');
const quick = require('quickswap-sdk');
const ethers = require('ethers');
const proxyArtifact = require('../static/quickswap_router_abi.json');
const routeTokens = require('../static/quickswap_route_tokens.json');
const globalConfig =
  require('../services/configuration_manager').configManagerInstance;

// constants
const ROUTER = globalConfig.getConfig('QUICKSWAP_ROUTER');
const GAS_LIMIT = globalConfig.getConfig('QUICKSWAP_GAS_LIMIT') || 150688;
const TTL = globalConfig.getConfig('QUICKSWAP_TTL') || 300;
const UPDATE_PERIOD = globalConfig.getConfig('QUICKSWAP_UPDATE_PERIOD') || 300000; // stop updating pair after 5 minutes from last request

export default class Quicswap {
  constructor(network = 'matic') {
    this.providerUrl = globalConfig.getConfig('ETHEREUM_RPC_URL');
    this.network = globalConfig.getConfig('ETHEREUM_CHAIN');
    this.provider = new ethers.providers.JsonRpcProvider(this.providerUrl);
    this.router = ROUTER;
    this.slippage = math.fraction(
      globalConfig.getConfig('QUICKSWAP_ALLOWED_SLIPPAGE')
    );
    this.allowedSlippage = new quick.Percent(
      this.slippage.n,
      this.slippage.d * 100
    );
    this.pairsCacheTime = globalConfig.getConfig('QUICKSWAP_PAIRS_CACHE_TIME');
    this.gasLimit = GAS_LIMIT;
    this.expireTokenPairUpdate = UPDATE_PERIOD;
    this.zeroReserveCheckInterval = globalConfig.getConfig(
      'QUICKSWAP_NO_RESERVE_CHECK_INTERVAL'
    );
    this.zeroReservePairs = {}; // No reserve pairs
    this.tokenList = {};
    this.pairs = [];
    this.tokenSwapList = {};
    this.cachedRoutes = {};

    switch (network) {
      case 'matic':
        this.chainID = quick.ChainId.MATIC;
        break;
      case 'mumbai':
        this.chainID = quick.ChainId.MUMBAI;
        break;
      default: {
        const err = `Invalid network ${network}`;
        logger.error(err);
        throw Error(err);
      }
    }
  }

  async fetch_route(tIn, tOut) {
    var route, pair;

    try {
      pair = await quick.Fetcher.fetchPairData(tIn, tOut);
      route = new quick.Route([pair], tIn, tOut);
    } catch (err) {
      logger.error(err);
    }
    return route;
  }

  generate_tokens() {
    for (let token of routeTokens[this.network]) {
      this.tokenList[token['address']] = new quick.Token(
        this.chainID,
        token['address'],
        token['decimals'],
        token['symbol'],
        token['name']
      );
    }
  }

  async extend_update_pairs(tokens = []) {
    for (let token of tokens) {
      if (!Object.prototype.hasOwnProperty.call(this.tokenList, token)) {
        this.tokenList[token] = await quick.Fetcher.fetchTokenData(
          this.chainID,
          token
        );
      }
      this.tokenSwapList[token] = Date.now() + this.expireTokenPairUpdate;
    }
  }

  async update_pairs() {
    // Remove banned pairs after ban period
    if (Object.keys(this.zeroReservePairs).length > 0) {
      for (let pair in this.zeroReservePairs) {
        if (this.zeroReservePairs[pair] <= Date.now()) {
          delete this.zeroReservePairs[pair];
          // delete this.tokenList[token];
        }
      }
    }
    // Generate all possible pair combinations of tokens
    // This is done by generating an upper triangular matrix or right triangular matrix
    if (Object.keys(this.tokenSwapList).length > 0) {
      for (let token in this.tokenSwapList) {
        if (this.tokenSwapList[token] <= Date.now()) {
          delete this.tokenSwapList[token];
          // delete this.tokenList[token];
        }
      }

      let tokens = Object.keys(this.tokenList);
      var firstToken, secondToken, position;
      let length = tokens.length;
      let pairs = [];
      let pairAddressRequests = [];
      let pairAddressResponses = [];
      for (firstToken = 0; firstToken < length; firstToken++) {
        for (
          secondToken = firstToken + 1;
          secondToken < length;
          secondToken++
        ) {
          try {
            let pairString =
              this.tokenList[tokens[firstToken]].address +
              '-' +
              this.tokenList[tokens[secondToken]].address;
            if (
              !Object.prototype.hasOwnProperty.call(
                this.zeroReservePairs,
                pairString
              )
            ) {
              pairs.push(pairString);
              pairAddressRequests.push(
                quick.Fetcher.fetchPairData(
                  this.tokenList[tokens[firstToken]],
                  this.tokenList[tokens[secondToken]]
                )
              );
            }
          } catch (err) {
            logger.error(err);
          }
        }
      }

      await Promise.allSettled(pairAddressRequests).then((values) => {
        for (position = 0; position < pairAddressRequests.length; position++) {
          if (values[position].status === 'fulfilled') {
            pairAddressResponses.push(values[position].value);
          } else {
            this.zeroReservePairs[pairs[position]] =
              Date.now() + this.zeroReserveCheckInterval;
          }
        }
      });
      this.pairs = pairAddressResponses;
    }
    setTimeout(this.update_pairs.bind(this), 1000);
  }

  async priceSwapIn(tokenIn, tokenOut, tokenInAmount) {
    await this.extend_update_pairs([tokenIn, tokenOut]);
    const tIn = this.tokenList[tokenIn];
    const tOut = this.tokenList[tokenOut];
    const tokenAmountIn = new quick.TokenAmount(
      tIn,
      ethers.utils.parseUnits(tokenInAmount, tIn.decimals)
    );
    if (this.pairs.length === 0) {
      const route = await this.fetch_route(tIn, tOut);
      const trade = quick.Trade.exactIn(route, tokenAmountIn);
      if (trade !== undefined) {
        const expectedAmount = trade.minimumAmountOut(this.allowedSlippage);
        this.cachedRoutes[tIn.symbol + tOut.Symbol] = trade;
        return {trade, expectedAmount};
      }
      return "Can't find route to swap, kindly update ";
    }
    let trade = quick.Trade.bestTradeExactIn(
      this.pairs,
      tokenAmountIn,
      this.tokenList[tokenOut],
      {maxHops: 5}
    )[0];
    if (trade === undefined) {
      trade = this.cachedRoutes[tIn.symbol + tOut.Symbol];
    } else {
      this.cachedRoutes[tIn.symbol + tOut.Symbol] = trade;
    }
    const expectedAmount = trade.minimumAmountOut(this.allowedSlippage);
    return {trade, expectedAmount};
  }

  async priceSwapOut(tokenIn, tokenOut, tokenOutAmount) {
    await this.extend_update_pairs([tokenIn, tokenOut]);
    const tOut = this.tokenList[tokenOut];
    const tIn = this.tokenList[tokenIn];
    const tokenAmountOut = new quick.TokenAmount(
      tOut,
      ethers.utils.parseUnits(tokenOutAmount, tOut.decimals)
    );
    if (this.pairs.length === 0) {
      const route = await this.fetch_route(tIn, tOut);
      const trade = quick.Trade.exactOut(route, tokenAmountOut);
      if (trade !== undefined) {
        const expectedAmount = trade.maximumAmountIn(this.allowedSlippage);
        this.cachedRoutes[tIn.symbol + tOut.Symbol] = trade;
        return {trade, expectedAmount};
      }
      return;
    }
    let trade = quick.Trade.bestTradeExactOut(
      this.pairs,
      this.tokenList[tokenIn],
      tokenAmountOut,
      {maxHops: 5}
    )[0];
    if (trade === undefined) {
      trade = this.cachedRoutes[tIn.symbol + tOut.Symbol];
    } else {
      this.cachedRoutes[tIn.symbol + tOut.Symbol] = trade;
    }
    const expectedAmount = trade.maximumAmountIn(this.allowedSlippage);
    return {trade, expectedAmount};
  }

  async swapExactIn(wallet, trade, tokenAddress, gasPrice) {
    const result = quick.Router.swapCallParameters(trade, {
      ttl: TTL,
      recipient: wallet.address,
      allowedSlippage: this.allowedSlippage,
    });

    const contract = new ethers.Contract(
      this.router,
      proxyArtifact.abi,
      wallet
    );
    const tx = await contract[result.methodName](...result.args, {
      gasPrice: gasPrice * 1e9,
      gasLimit: GAS_LIMIT,
      value: result.value,
    });

    debug(`Tx Hash: ${tx.hash}`);
    return tx;
  }

  async swapExactOut(wallet, trade, tokenAddress, gasPrice) {
    const result = quick.Router.swapCallParameters(trade, {
      ttl: TTL,
      recipient: wallet.address,
      allowedSlippage: this.allowedSlippage,
    });

    const contract = new ethers.Contract(
      this.router,
      proxyArtifact.abi,
      wallet
    );
    const tx = await contract[result.methodName](...result.args, {
      gasPrice: gasPrice * 1e9,
      gasLimit: GAS_LIMIT,
      value: result.value,
    });

    debug(`Tx Hash: ${tx.hash}`);
    return tx;
  }
}
