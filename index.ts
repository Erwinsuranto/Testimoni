import crypto from 'crypto';
import { IProviderDriver, IProviderConfig } from '../index';

function md5(data: string): string {
  return crypto.createHash('md5').update(data).digest('hex');
}

export const digiflazzDriver: IProviderDriver = {
  async testConnection(config: IProviderConfig) {
    try {
      const balanceRes = await this.getBalance(config);
      if (balanceRes.success) {
        return {
          success: true,
          message: `Koneksi Berhasil! Saldo saat ini: Rp ${balanceRes.balance.toLocaleString('id-ID')}`,
          balance: balanceRes.balance
        };
      }
      return { success: false, message: `Gagal menghubungkan: ${balanceRes.currency}` };
    } catch (error: any) {
      return { success: false, message: `Koneksi gagal: ${error.message}` };
    }
  },

  async getBalance(config: IProviderConfig) {
    const url = `${config.apiUrl || 'https://api.digiflazz.com/v1'}/cek-saldo`;
    const sign = md5(config.username + config.apiKey + 'depo');
    const payload = {
      cmd: 'deposit',
      username: config.username,
      sign
    };

    // If config has no real apiKey, simulate for smooth preview experience
    if (!config.apiKey || config.apiKey.toLowerCase().includes('dummy') || config.apiKey === '') {
      return {
        success: true,
        balance: 5750000,
        currency: 'IDR'
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error('HTTP Error ${response.status}: ${response.statusText}');
    }

    const resData: any = await response.json();
 if (resData.data && typeof resData.data.deposit !== 'undefined') {
    return {
        success: true,
        balance: Number(resData.data.deposit || 0),
        currency: 'IDR'
    };
}

console.log('DIGIFLAZZ RESPONSE:', JSON.stringify(resData, null, 2));

throw new Error(
    resData?.data?.message ||
    resData?.message ||
    JSON.stringify(resData)
);
},

  async getProducts(config: IProviderConfig) {
    const url = `${config.apiUrl || 'https://api.digiflazz.com/v1'}/price-list`;
    const sign = md5(config.username + config.apiKey + 'pricelist');
    const payload = {
      cmd: 'prepaid',
      username: config.username,
      sign
    };

    if (!config.apiKey || config.apiKey.toLowerCase().includes('dummy') || config.apiKey === '') {
      // Return beautiful mock prepaid products for Digiflazz simulation
      return [
        { code: 'tsel5', name: 'Telkomsel Rp 5.000', price: 5150, category: 'Pulsa', brand: 'Telkomsel', status: 'aktif' as const, desc: 'Pulsa murah instan Telkomsel' },
        { code: 'tsel10', name: 'Telkomsel Rp 10.000', price: 10150, category: 'Pulsa', brand: 'Telkomsel', status: 'aktif' as const, desc: 'Pulsa murah instan Telkomsel' },
        { code: 'xl5', name: 'XL Rp 5.000', price: 5200, category: 'Pulsa', brand: 'XL', status: 'aktif' as const, desc: 'Pulsa murah instan XL' },
        { code: 'xl10', name: 'XL Rp 10.000', price: 10200, category: 'Pulsa', brand: 'XL', status: 'aktif' as const, desc: 'Pulsa murah instan XL' }
      ];
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const status = response.status;
    let responseBody = '';
    let resData: unknown = null;

    try {
      responseBody = await response.text();
      resData = JSON.parse(responseBody);
    } catch (parseError) {
      // Handle non-JSON or failed read gracefully
    }

    // Logging lebih informatif: HTTP Status dan Response Body
    console.log(`[Digiflazz getProducts] HTTP Status: ${status}`);
    console.log(`[Digiflazz getProducts] Response Body: ${responseBody}`);

    if (!response.ok) {
      let errMsg = `HTTP Error ${status}: ${response.statusText}`;
      if (resData && typeof resData === 'object') {
        const obj = resData as Record<string, unknown>;
        if (typeof obj.message === 'string') {
          errMsg = obj.message;
        } else if (obj.data && typeof obj.data === 'object' && obj.data !== null) {
          const dataObj = obj.data as Record<string, unknown>;
          if (typeof dataObj.message === 'string') {
            errMsg = dataObj.message;
          }
        }
      }
      console.error(`[Digiflazz getProducts] Error Message: ${errMsg}`);
      throw new Error(errMsg);
    }

    if (!resData || typeof resData !== 'object') {
      const errMsg = 'Response dari Digiflazz kosong atau bukan format JSON yang valid.';
      console.error(`[Digiflazz getProducts] Error Message: ${errMsg}`);
      throw new Error(errMsg);
    }

    const obj = resData as Record<string, unknown>;

    // Cek apakah API mengembalikan error message asli dari Digiflazz
    if (typeof obj.message === 'string' && obj.message.trim() !== '') {
      console.error(`[Digiflazz getProducts] Error Message dari Digiflazz: ${obj.message}`);
      throw new Error(obj.message);
    }

    if (obj.data && typeof obj.data === 'object') {
      const dataObj = obj.data as Record<string, unknown>;
      if (typeof dataObj.message === 'string' && dataObj.message.trim() !== '') {
        console.error(`[Digiflazz getProducts] Error Message dari Digiflazz (data): ${dataObj.message}`);
        throw new Error(dataObj.message);
      }
    }

    // Cek apakah resData.data ada
    if (!obj.hasOwnProperty('data') || obj.data === null || obj.data === undefined) {
      const errMsg = 'Field data kosong atau tidak ditemukan dalam response Digiflazz.';
      console.error(`[Digiflazz getProducts] Error Message: ${errMsg}`);
      throw new Error(errMsg);
    }

    // Cek apakah resData.data benar-benar array menggunakan Array.isArray()
    if (!Array.isArray(obj.data)) {
      const errMsg = 'Format data dari Digiflazz tidak valid (bukan array/list).';
      console.error(`[Digiflazz getProducts] Error Message: ${errMsg}`);
      throw new Error(errMsg);
    }

    // Jika array kosong, tampilkan pesan yang jelas
    if (obj.data.length === 0) {
      const errMsg = 'Daftar produk dari Digiflazz kosong. Tidak ada produk yang tersedia.';
      console.warn(`[Digiflazz getProducts] Warning Message: ${errMsg}`);
      throw new Error(errMsg);
    }

    return obj.data.map((item: any) => ({
      code: item.buyer_sku_code,
      name: item.product_name,
      price: Number(item.price),
      category: item.category,
      brand: item.brand,
      status: item.buyer_product_status && item.seller_product_status ? ('aktif' as const) : ('nonaktif' as const),
      desc: item.desc
    }));
  },

  async createTransaction(config: IProviderConfig, txData: { orderId: string; productCode: string; targetNumber: string }) {
    const url = `${config.apiUrl || 'https://api.digiflazz.com/v1'}/transaction`;
    const sign = md5(config.username + config.apiKey + txData.orderId);
    const payload = {
      username: config.username,
      buyer_sku_code: txData.productCode,
      customer_no: txData.targetNumber,
      ref_id: txData.orderId,
      sign
    };

    if (!config.apiKey || config.apiKey.toLowerCase().includes('dummy') || config.apiKey === '') {
      // Simulation success
      return {
        success: true,
        txId: `DF-${Math.floor(100000 + Math.random() * 900000)}`,
        status: 'success' as const,
        message: 'Transaksi Sukses (Simulasi)',
        rawResponse: { data: { rc: '00', status: 'Sukses', sn: '8172938291038291', price: 5150 } }
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
    }

    const resData: any = await response.json();
    const data = resData.data;
    if (!data) {
      throw new Error('Response data kosong dari Digiflazz.');
    }

    // Digiflazz rc 00 (Sukses) or rc 03 (Pending)
    const status = data.status === 'Sukses' ? 'success' as const : (data.status === 'Gagal' ? 'failed' as const : 'pending' as const);
    return {
      success: true,
      txId: data.ref_id || txData.orderId,
      status,
      message: data.message || 'Transaksi diproses.',
      rawResponse: resData
    };
  },

  async checkTransaction(config: IProviderConfig, txId: string, orderId: string) {
    const url = `${config.apiUrl || 'https://api.digiflazz.com/v1'}/transaction`;
    const sign = md5(config.username + config.apiKey + orderId);
    const payload = {
      username: config.username,
      buyer_sku_code: 'status', // For query status in prepaid digiflazz
      customer_no: 'status',
      ref_id: orderId,
      sign
    };

    if (!config.apiKey || config.apiKey.toLowerCase().includes('dummy') || config.apiKey === '') {
      return {
        success: true,
        status: 'success' as const,
        message: 'Transaksi Sukses (Simulasi)',
        rawResponse: { simulated: true }
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
    }

    const resData: any = await response.json();
    const data = resData.data;
    if (!data) {
      throw new Error('Response data status kosong dari Digiflazz.');
    }

    const status = data.status === 'Sukses' ? 'success' as const : (data.status === 'Gagal' ? 'failed' as const : 'pending' as const);
    return {
      success: true,
      status,
      message: data.message || 'Status transaksi terbaru retrieved.',
      rawResponse: resData
    };
  }
};
