import BigNumber from 'bignumber.js';
import { ethers } from 'ethers';
import express from 'express';
import { Request, Response } from 'express';

import { latency, statusMessages } from '../services/utils';

import { EthereumService } from '../services/ethereum';
import { EthereumConfigService } from '../services/ethereum_config';

import Balancer from '../services/balancer';
import Fees from '../services/fees';
import { logger } from '../services/logger';

const debug = require('debug')('router');
const router = express.Router();
const globalConfig =
  require('../services/configuration_manager').configManagerInstance;

const balancer = new Balancer(globalConfig.getConfig('ETHEREUM_CHAIN'));
const fees = new Fees();

const ethConfig = new EthereumConfigService();
const eth = new EthereumService(ethConfig);

const swapMoreThanMaxPriceError = 'Price too high';
const swapLessThanMaxPriceError = 'Price too low';

const estimateGasLimit = (maxswaps: number) => {
  const gasLimit = balancer.gasBase + maxswaps * balancer.gasPerSwap;
  return gasLimit;
};

router.post('/', async (_req: Request, res: Response) => {
  /*
    POST /
  */
  res.status(200).json({
    network: balancer.network,
    provider: balancer.provider.connection.url,
    exchangeProxy: balancer.exchangeProxy,
    subgraphUrl: balancer.subgraphUrl,
    connection: true,
    timestamp: Date.now(),
  });
});

router.post('/gas-limit', async (req: Request, res: Response) => {
  /*
    POST: /gas-limit
  */
  try {
    const swaps = req.body.maxSwaps;
    const maxSwaps =
      typeof swaps === 'undefined' || parseInt(swaps) === 0
        ? balancer.maxSwaps
        : parseInt(swaps);
    const gasLimit = estimateGasLimit(maxSwaps);

    res.status(200).json({
      network: balancer.network,
      gasLimit: gasLimit,
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error(req.originalUrl, { message: err });
    let reason;
    err.reason
      ? (reason = err.reason)
      : (reason = statusMessages.operation_error);
    res.status(500).json({
      error: reason,
      message: err,
    });
  }
});

router.get('/start', async (req: Request, res: Response) => {
  /*
    GET: /eth/balancer/start?pairs=["BAT-DAI"]&gasPrice=30
  */
  const initTime = Date.now();

  if (typeof req.query.pairs === 'string') {
    const pairs = JSON.parse(req.query.pairs);
    let gasPrice;
    if (typeof req.query.gasPrice === 'string') {
      gasPrice = parseFloat(req.query.gasPrice);
    } else {
      gasPrice = fees.ethGasPrice;
    }

    // get token contract address and cache pools
    for (let pair of pairs) {
      pair = pair.split('-');
      const baseTokenSymbol = pair[0];
      const quoteTokenSymbol = pair[1];
      const baseTokenContractInfo = eth.getERC20TokenAddress(baseTokenSymbol);
      const quoteTokenContractInfo = eth.getERC20TokenAddress(quoteTokenSymbol);

      // check for valid token symbols

      if (baseTokenContractInfo && quoteTokenContractInfo) {
        await Promise.allSettled([
          balancer.fetchPool(
            baseTokenContractInfo.address,
            quoteTokenContractInfo.address
          ),
          balancer.fetchPool(
            quoteTokenContractInfo.address,
            baseTokenContractInfo.address
          ),
        ]);
      } else {
        const undefinedToken =
          baseTokenContractInfo === undefined
            ? baseTokenSymbol
            : quoteTokenSymbol;
        res.status(500).json({
          error: `Token ${undefinedToken} contract address not found`,
          message: `Token contract address not found for ${undefinedToken}. Check token list source`,
        });
        return;
      }
    }

    const gasLimit = estimateGasLimit(balancer.maxSwaps);
    const gasCost = await fees.getGasCost(gasPrice, gasLimit);

    const result = {
      network: eth.networkName,
      timestamp: initTime,
      latency: latency(initTime, Date.now()),
      success: true,
      pairs: pairs,
      gasPrice: gasPrice,
      gasLimit: gasLimit,
      gasCost: gasCost,
    };
    logger.info('Initializing balancer');
    res.status(200).json(result);
  } else {
    res.status(500).json({ err: 'unexpected pairs type' });
  }
});

router.post('/price', async (req: Request, res: Response) => {
  /*
    POST: /eth/balancer/price
      x-www-form-urlencoded: {
        "quote":"BAT"
        "base":"USDC"
        "amount":0.1
        "side":buy
      }
  */
  const initTime = Date.now();
  // params: base (required), quote (required), amount (required)
  const baseTokenContractInfo = eth.getERC20TokenAddress(req.body.base);
  const quoteTokenContractInfo = eth.getERC20TokenAddress(req.body.quote);

  if (baseTokenContractInfo && quoteTokenContractInfo) {
    const baseTokenAddress = baseTokenContractInfo.address;
    const quoteTokenAddress = quoteTokenContractInfo.address;
    const baseDenomMultiplier = 10 ** baseTokenContractInfo.decimals;
    const quoteDenomMultiplier = 10 ** quoteTokenContractInfo.decimals;
    const amount = new BigNumber(
      parseInt(req.body.amount) * baseDenomMultiplier
    );
    const maxSwaps = balancer.maxSwaps;
    const side = req.body.side.toUpperCase();
    let gasPrice;
    if (req.body.gasPrice) {
      gasPrice = parseFloat(req.body.gasPrice);
    } else {
      gasPrice = fees.ethGasPrice;
    }

    try {
      // fetch the optimal pool mix from balancer-sor
      const { swaps, expectedAmount } =
        side === 'BUY'
          ? await balancer.priceSwapOut(
              quoteTokenAddress, // tokenIn is quote asset
              baseTokenAddress, // tokenOut is base asset
              amount,
              maxSwaps
            )
          : await balancer.priceSwapIn(
              baseTokenAddress, // tokenIn is base asset
              quoteTokenAddress, // tokenOut is quote asset
              amount,
              maxSwaps
            );

      if (swaps != null && expectedAmount != null) {
        const gasLimit = estimateGasLimit(swaps.length);
        const gasCost = await fees.getGasCost(gasPrice, gasLimit);

        const expectedTradeAmount =
          parseInt(expectedAmount) / quoteDenomMultiplier;
        const tradePrice =
          ((expectedAmount / Number(amount)) * baseDenomMultiplier) /
          quoteDenomMultiplier;

        const result = {
          network: balancer.network,
          timestamp: initTime,
          latency: latency(initTime, Date.now()),
          base: baseTokenContractInfo,
          quote: quoteTokenContractInfo,
          amount: Number(amount),
          side: side,
          expectedAmount: expectedTradeAmount,
          price: tradePrice,
          gasPrice: gasPrice,
          gasLimit: gasLimit,
          gasCost: gasCost,
          swaps: swaps,
        };
        debug(
          `Price ${side} ${baseTokenContractInfo.symbol}-${quoteTokenContractInfo.symbol} | amount:${amount} (rate:${tradePrice}) - gasPrice:${gasPrice} gasLimit:${gasLimit} estimated fee:${gasCost} ETH`
        );
        res.status(200).json(result);
      } else {
        // no pool available
        res.status(200).json({
          info: statusMessages.no_pool_available,
          message: statusMessages.no_pool_available,
        });
      }
    } catch (err) {
      logger.error(req.originalUrl, { message: err });
      let reason;
      err.reason
        ? (reason = err.reason)
        : (reason = statusMessages.operation_error);
      res.status(500).json({
        error: reason,
        message: err,
      });
    }
  } else {
    res.status(500).json({
      error: 'unknown tokens',
      message: 'unknown tokens',
    });
  }
});

router.post('/trade', async (req: Request, res: Response) => {
  /*
      POST: /trade
      x-www-form-urlencoded: {
        "quote":"BAT"
        "base":"USDC"
        "amount":0.1
        "limitPrice":1
        "gasPrice":10
        "side":{buy|sell}
        "privateKey":{{privateKey}}
      }
  */
  const initTime = Date.now();
  const privateKey = req.body.privateKey;
  const wallet = new ethers.Wallet(privateKey, balancer.provider);

  const baseTokenContractInfo = eth.getERC20TokenAddress(req.body.base);
  const quoteTokenContractInfo = eth.getERC20TokenAddress(req.body.quote);

  if (baseTokenContractInfo && quoteTokenContractInfo) {
    const baseTokenAddress = baseTokenContractInfo.address;
    const quoteTokenAddress = quoteTokenContractInfo.address;
    const baseDenomMultiplier = 10 ** baseTokenContractInfo.decimals;
    const quoteDenomMultiplier = 10 ** quoteTokenContractInfo.decimals;
    const amount = new BigNumber(
      parseInt(req.body.amount) * baseDenomMultiplier
    );

    const maxSwaps = balancer.maxSwaps;
    const side = req.body.side.toUpperCase();

    const limitPrice = parseFloat(req.body.limitPrice || '0');

    let gasPrice;
    if (req.body.gasPrice) {
      gasPrice = parseFloat(req.body.gasPrice);
    } else {
      gasPrice = fees.ethGasPrice;
    }

    try {
      // fetch the optimal pool mix from balancer-sor
      const { swaps, expectedAmount } =
        side === 'BUY'
          ? await balancer.priceSwapOut(
              quoteTokenAddress, // tokenIn is quote asset
              baseTokenAddress, // tokenOut is base asset
              amount,
              maxSwaps
            )
          : await balancer.priceSwapIn(
              baseTokenAddress, // tokenIn is base asset
              quoteTokenAddress, // tokenOut is quote asset
              amount,
              maxSwaps
            );

      const gasLimit = estimateGasLimit(swaps.length);
      const gasCost = await fees.getGasCost(gasPrice, gasLimit);

      if (side === 'BUY') {
        const price =
          ((expectedAmount / Number(amount)) * baseDenomMultiplier) /
          quoteDenomMultiplier;
        logger.info(`Price: ${price.toString()}`);
        if (!limitPrice || price <= limitPrice) {
          // pass swaps to exchange-proxy to complete trade
          const tx = await balancer.swapExactOut(
            wallet,
            swaps,
            quoteTokenAddress, // tokenIn is quote asset
            baseTokenAddress, // tokenOut is base asset
            expectedAmount.toString(),
            gasPrice
          );

          // submit response
          res.status(200).json({
            network: balancer.network,
            timestamp: initTime,
            latency: latency(initTime, Date.now()),
            base: baseTokenContractInfo,
            quote: quoteTokenContractInfo,
            amount: parseFloat(req.body.amount),
            expectedIn: expectedAmount / quoteDenomMultiplier,
            price: price,
            gasPrice: gasPrice,
            gasLimit: gasLimit,
            gasCost: gasCost,
            txHash: tx.hash,
          });
        } else {
          res.status(200).json({
            error: swapMoreThanMaxPriceError,
            message: `Swap price ${price} exceeds limitPrice ${limitPrice}`,
          });
          debug(`Swap price ${price} exceeds limitPrice ${limitPrice}`);
        }
      } else {
        // sell
        const minAmountOut =
          (limitPrice / Number(amount)) * baseDenomMultiplier;
        debug('minAmountOut', minAmountOut);
        const price =
          ((expectedAmount / Number(amount)) * baseDenomMultiplier) /
          quoteDenomMultiplier;
        logger.info(`Price: ${price.toString()}`);
        if (!limitPrice || price >= limitPrice) {
          // pass swaps to exchange-proxy to complete trade
          const tx = await balancer.swapExactIn(
            wallet,
            swaps,
            baseTokenAddress, // tokenIn is base asset
            quoteTokenAddress, // tokenOut is quote asset
            amount.toString(),
            parseInt(expectedAmount) / quoteDenomMultiplier,
            gasPrice
          );
          // submit response
          res.status(200).json({
            network: balancer.network,
            timestamp: initTime,
            latency: latency(initTime, Date.now()),
            base: baseTokenContractInfo,
            quote: quoteTokenContractInfo,
            amount: parseFloat(req.body.amount),
            expectedOut: expectedAmount / quoteDenomMultiplier,
            price: price,
            gasPrice: gasPrice,
            gasLimit: gasLimit,
            gasCost: gasCost,
            txHash: tx.hash,
          });
        } else {
          res.status(200).json({
            error: swapLessThanMaxPriceError,
            message: `Swap price ${price} lower than limitPrice ${limitPrice}`,
          });
          debug(`Swap price ${price} lower than limitPrice ${limitPrice}`);
        }
      }
    } catch (err) {
      logger.error(req.originalUrl, { message: err });
      let reason;
      err.reason
        ? (reason = err.reason)
        : (reason = statusMessages.operation_error);
      res.status(500).json({
        error: reason,
        message: err,
      });
    }
  } else {
    res.status(500).json({
      error: 'unknown tokens',
      message: 'unknown tokens',
    });
  }
});

export default router;
