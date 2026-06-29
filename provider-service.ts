import { DB } from '../db';
import { getDriver, IProviderConfig } from './index';

export class ProviderService {
  /**
   * Helper to execute driver methods with automatic audit logging and timing.
   */
  private static async executeWithAudit<T>(
    providerId: string,
    providerName: string,
    action: string,
    endpoint: string,
    payload: any,
    fn: () => Promise<T>
  ): Promise<T> {
    const startTime = Date.now();
    let result: T | null = null;
    let errorMsg: string | undefined;

    try {
      result = await fn();
      return result;
    } catch (error: any) {
      errorMsg = error.message || String(error);
      throw error;
    } finally {
      const duration = Date.now() - startTime;
      
      // Save detailed audit log asynchronously without blocking main flow
      try {
        await DB.ProviderAuditLogs.create({
          provider_id: providerId,
          provider_name: providerName,
          action,
          endpoint,
          request_payload: typeof payload === 'object' ? JSON.stringify(payload) : String(payload),
          response_payload: result ? JSON.stringify(result) : 'N/A',
          error_message: errorMsg,
          duration_ms: duration
        });
      } catch (logErr) {
        console.error('Failed to write provider audit log:', logErr);
      }
    }
  }

  /**
   * Test connection to a provider.
   */
  static async testConnection(providerId: string) {
    const providers = await DB.Providers.find({ id: providerId });
    if (providers.length === 0) {
      throw new Error('Provider tidak ditemukan.');
    }
    const provider = providers[0];
    const driver = getDriver(provider.code || provider.nama);

    const config: IProviderConfig = {
      apiUrl: provider.apiUrl || '',
      username: provider.username || '',
      apiKey: provider.apiKey || '',
      secretKey: provider.secretKey || ''
    };

    return this.executeWithAudit(
      provider.id,
      provider.nama,
      'testConnection',
      provider.apiUrl || 'N/A',
      config,
      () => driver.testConnection(config)
    );
  }

  /**
   * Get balance from a provider.
   */
  static async getBalance(providerId: string) {
    const providers = await DB.Providers.find({ id: providerId });
    if (providers.length === 0) {
      throw new Error('Provider tidak ditemukan.');
    }
    const provider = providers[0];
    const driver = getDriver(provider.code || provider.nama);

    const config: IProviderConfig = {
      apiUrl: provider.apiUrl || '',
      username: provider.username || '',
      apiKey: provider.apiKey || '',
      secretKey: provider.secretKey || ''
    };

    return this.executeWithAudit(
      provider.id,
      provider.nama,
      'getBalance',
      `${provider.apiUrl || 'N/A'}/cek-saldo`,
      config,
      () => driver.getBalance(config)
    );
  }

  /**
   * Retrieve products list from a provider API.
   */
  static async getProducts(providerId: string) {
    const providers = await DB.Providers.find({ id: providerId });
    if (providers.length === 0) {
      throw new Error('Provider tidak ditemukan.');
    }
    const provider = providers[0];
    const driver = getDriver(provider.code || provider.nama);

    const config: IProviderConfig = {
      apiUrl: provider.apiUrl || '',
      username: provider.username || '',
      apiKey: provider.apiKey || '',
      secretKey: provider.secretKey || ''
    };

    return this.executeWithAudit(
      provider.id,
      provider.nama,
      'getProducts',
      `${provider.apiUrl || 'N/A'}/price-list`,
      config,
      () => driver.getProducts(config)
    );
  }

  /**
   * Process and route order transaction through provider API.
   * Includes duplicate check and automatic retry loop.
   */
  static async processOrder(orderId: string): Promise<any> {
    const orders = await DB.Orders.find({ id: orderId });
    if (orders.length === 0) {
      throw new Error(`Order ${orderId} tidak ditemukan.`);
    }
    const order = orders[0];

    // Check if transaction has already been processed successfully (prevent duplicate transactions)
    const existingLogs = await DB.ProviderAuditLogs.find({});
    const duplicateTx = existingLogs.find(
      log => log.action === 'createTransaction' && 
             log.request_payload.includes(orderId) && 
             !log.error_message
    );

    if (duplicateTx) {
      console.log(`[ProviderService] Order ${orderId} already processed (Log ID: ${duplicateTx.id}). Skipping to prevent double transaction.`);
      const payloadParsed = JSON.parse(duplicateTx.response_payload);
      return payloadParsed;
    }

    // Resolve product and provider
    const orderItems = await DB.OrderItems.find({ order_id: orderId });
    if (orderItems.length === 0) {
      throw new Error(`Order items tidak ditemukan untuk order ${orderId}.`);
    }

    const firstItem = orderItems[0];
    const productsFound = await DB.Products.find({ id: firstItem.product_id });
    if (productsFound.length === 0) {
      throw new Error(`Product ${firstItem.product_id} tidak ditemukan.`);
    }
    const product = productsFound[0];

    // Find assigned provider
    const providersFound = await DB.Providers.find({ id: product.provider_id });
    if (providersFound.length === 0) {
      throw new Error(`Provider untuk produk ${product.nama} tidak ditemukan.`);
    }
    
    let targetProvider = providersFound[0];

    // Get active providers sorted by priority ascending (1 is highest, 3 is lowest)
    const activeProviders = await DB.Providers.find({ status: 'aktif' });
    activeProviders.sort((a, b) => (a.prioritas || 3) - (b.prioritas || 3));

    // Prioritize target provider, fallback to others
    let routedProviders = [...activeProviders];
    const primaryIdx = routedProviders.findIndex(p => p.id === targetProvider.id);
    if (primaryIdx !== -1) {
      routedProviders.splice(primaryIdx, 1);
      routedProviders.unshift(targetProvider);
    } else if (targetProvider.status === 'aktif') {
      routedProviders.unshift(targetProvider);
    }

    if (routedProviders.length === 0) {
      throw new Error(`Tidak ada provider aktif untuk memproses pesanan.`);
    }

    const targetNumber = order.nomor_tujuan || order.nomor_whatsapp || '';
    let lastError: any = null;

    for (let pIndex = 0; pIndex < routedProviders.length; pIndex++) {
      const currentProvider = routedProviders[pIndex];
      const driver = getDriver(currentProvider.code || currentProvider.nama);
      const config: IProviderConfig = {
        apiUrl: currentProvider.apiUrl || '',
        username: currentProvider.username || '',
        apiKey: currentProvider.apiKey || '',
        secretKey: currentProvider.secretKey || ''
      };

      // Resolve product code for fallback providers
      let productCode = product.kode_produk || product.id;
      if (currentProvider.id !== targetProvider.id) {
        const matchedProducts = await DB.Products.find({
          provider_id: currentProvider.id,
          brand: product.brand,
          category_id: product.category_id
        });
        if (matchedProducts.length > 0) {
          productCode = matchedProducts[0].kode_produk;
          console.log(`[ProviderService] Failover: Routed to ${currentProvider.nama}. Found matching SKU: ${productCode}`);
        } else {
          console.log(`[ProviderService] Failover: Skipping provider ${currentProvider.nama} - no matching SKU found.`);
          continue;
        }
      }

      const maxRetries = 3;
      let attempt = 0;
      let providerFailed = false;

      while (attempt < maxRetries) {
        attempt++;
        try {
          console.log(`[ProviderService] Sending order ${orderId} to provider ${currentProvider.nama} (Attempt ${attempt}/${maxRetries})`);
          
          const response = await this.executeWithAudit(
            currentProvider.id,
            currentProvider.nama,
            'createTransaction',
            `${currentProvider.apiUrl || 'N/A'}/transaction`,
            { orderId, productCode, targetNumber },
            () => driver.createTransaction(config, {
              orderId,
              productCode,
              targetNumber
            })
          );

          if (response.status === 'failed') {
            throw new Error(response.message || 'Transaksi ditolak oleh provider.');
          }

          // Update Order Status based on provider response
          let statusPesanan: 'Diproses' | 'Berhasil' | 'Dibatalkan' = 'Diproses';
          let catatanAdmin = response.message || 'Transaksi sedang diproses oleh provider.';
          
          if (response.status === 'success') {
            statusPesanan = 'Berhasil';
            catatanAdmin = `Transaksi Berhasil! SN: ${response.rawResponse?.data?.sn || response.txId || '-'}`;
          }

          // Apply status update
          const updatedHistory = order.status_history || [];
          updatedHistory.push({
            time: new Date().toISOString(),
            status_lama: order.status_pesanan || 'pending',
            status_baru: statusPesanan,
            catatan: `${catatanAdmin} (via ${currentProvider.nama})`
          });

          await DB.Orders.findByIdAndUpdate(order.id, {
            status_pesanan: statusPesanan,
            catatan_admin: catatanAdmin,
            status_history: updatedHistory,
            provider: currentProvider.nama
          });

          // Notify user
          await DB.Notifications.create({
            user_id: order.user_id,
            title: statusPesanan === 'Berhasil' ? 'Pesanan Berhasil!' : 'Pesanan Diproses',
            message: statusPesanan === 'Berhasil' 
              ? `Pesanan ${order.id} Anda telah sukses diproses. ${catatanAdmin}`
              : `Pesanan ${order.id} Anda sedang diproses oleh provider.`,
            type: statusPesanan === 'Berhasil' ? 'success' : 'info'
          });

          return response;
        } catch (err: any) {
          lastError = err;
          console.warn(`[ProviderService] Attempt ${attempt} via ${currentProvider.nama} failed: ${err.message}`);
          if (attempt === maxRetries) {
            providerFailed = true;
          } else {
            // Exponential backoff delay (1s, 2s)
            await new Promise(resolve => setTimeout(resolve, attempt * 1000));
          }
        }
      }

      if (providerFailed && pIndex < routedProviders.length - 1) {
        const nextProvider = routedProviders[pIndex + 1];
        console.warn(`[ProviderService] Provider ${currentProvider.nama} failed. Failover routing to ${nextProvider.nama}.`);

        const updatedHistory = order.status_history || [];
        updatedHistory.push({
          time: new Date().toISOString(),
          status_lama: order.status_pesanan || 'pending',
          status_baru: 'Diproses',
          catatan: `Provider ${currentProvider.nama} gagal: ${lastError?.message || 'Unknown'}. Mengalihkan transaksi otomatis ke provider ${nextProvider.nama} (Prioritas: ${nextProvider.prioritas || 3}).`
        });
        await DB.Orders.findByIdAndUpdate(order.id, {
          status_history: updatedHistory
        });
      }
    }

    // If we exhausted all providers/retries and failed
    const errorMsg = lastError?.message || 'Gagal mengirimkan transaksi setelah mencoba seluruh provider cadangan.';
    console.error(`[ProviderService] All providers failed for order ${orderId}. Error: ${errorMsg}`);

    // Update order status to failed / pending retry
    const updatedHistory = order.status_history || [];
    updatedHistory.push({
      time: new Date().toISOString(),
      status_lama: order.status_pesanan || 'pending',
      status_baru: 'Diproses',
      catatan: `Seluruh provider gagal memproses transaksi. Terakhir: ${errorMsg}.`
    });

    await DB.Orders.findByIdAndUpdate(order.id, {
      status_pesanan: 'Diproses',
      catatan_admin: `Gagal mengirim ke seluruh provider: ${errorMsg}`,
      status_history: updatedHistory
    });

    throw new Error(errorMsg);
  }

  /**
   * Check status of a pending transaction from provider API.
   */
  static async checkTransactionStatus(orderId: string): Promise<any> {
    const orders = await DB.Orders.find({ id: orderId });
    if (orders.length === 0) {
      throw new Error(`Order ${orderId} tidak ditemukan.`);
    }
    const order = orders[0];

    // Find successful/pending logs for this order
    const logs = await DB.ProviderAuditLogs.find({});
    const createTxLog = logs.find(
      log => log.action === 'createTransaction' && log.request_payload.includes(orderId)
    );

    if (!createTxLog) {
      throw new Error(`Tidak ditemukan riwayat transaksi provider untuk order ${orderId}.`);
    }

    const providerId = createTxLog.provider_id;
    const providers = await DB.Providers.find({ id: providerId });
    if (providers.length === 0) {
      throw new Error('Provider tidak ditemukan.');
    }
    const provider = providers[0];

    // Load response to get transaction ID
    let txId = orderId;
    try {
      const responseObj = JSON.parse(createTxLog.response_payload);
      txId = responseObj.txId || responseObj.ref_id || orderId;
    } catch (e) {
      // fallback
    }

    const driver = getDriver(provider.code || provider.nama);
    const config: IProviderConfig = {
      apiUrl: provider.apiUrl || '',
      username: provider.username || '',
      apiKey: provider.apiKey || '',
      secretKey: provider.secretKey || ''
    };

    const statusResponse = await this.executeWithAudit(
      provider.id,
      provider.nama,
      'checkTransaction',
      `${provider.apiUrl || 'N/A'}/transaction`,
      { txId, orderId },
      () => driver.checkTransaction(config, txId, orderId)
    );

    if (statusResponse.status !== order.status_pesanan) {
      let statusPesanan: 'Diproses' | 'Berhasil' | 'Dibatalkan' = 'Diproses';
      let catatanAdmin = statusResponse.message || 'Transaksi sedang diproses.';

      if (statusResponse.status === 'success') {
        statusPesanan = 'Berhasil';
        catatanAdmin = `Transaksi Berhasil! SN: ${statusResponse.rawResponse?.data?.sn || '-'}`;
      } else if (statusResponse.status === 'failed') {
        statusPesanan = 'Dibatalkan';
        catatanAdmin = `Transaksi Gagal dari Provider: ${statusResponse.message}`;
      }

      const updatedHistory = order.status_history || [];
      updatedHistory.push({
        time: new Date().toISOString(),
        status_lama: order.status_pesanan || 'pending',
        status_baru: statusPesanan,
        catatan: `Sinkronisasi Status Provider: ${catatanAdmin}`
      });

      await DB.Orders.findByIdAndUpdate(order.id, {
        status_pesanan: statusPesanan,
        catatan_admin: catatanAdmin,
        status_history: updatedHistory
      });

      // Notify User
      await DB.Notifications.create({
        user_id: order.user_id,
        title: statusPesanan === 'Berhasil' ? 'Pesanan Sukses!' : 'Update Pesanan',
        message: `Status pesanan ${order.id} Anda diperbarui menjadi ${statusPesanan}: ${catatanAdmin}`,
        type: statusPesanan === 'Berhasil' ? 'success' : 'info'
      });
    }

    return statusResponse;
  }
}
