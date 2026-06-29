import { DB, IProduct, IMarginSetting } from '../db';
import { ProviderService } from './provider-service';

interface ProductCache {
  data: IProduct[];
  lastUpdate: number;
}

let productCache: ProductCache | null = null;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes default

export class ProductSyncEngine {
  /**
   * Clears the in-memory product cache.
   */
  static clearCache(): void {
    productCache = null;
    console.log('[ProductSyncEngine] In-memory product cache cleared.');
  }

  /**
   * Retrieves products, utilizing cache unless bypassCache is true or cache is expired.
   */
  static async getProducts(bypassCache = false): Promise<IProduct[]> {
    const now = Date.now();
    if (!bypassCache && productCache && (now - productCache.lastUpdate < CACHE_TTL)) {
      console.log('[ProductSyncEngine] Returning products from cache.');
      return productCache.data;
    }

    console.log('[ProductSyncEngine] Cache miss/bypass. Fetching products from database.');
    const products = await DB.Products.find();
    
    // Auto refresh prices for all products based on active margins to ensure accuracy
    const updatedProducts: IProduct[] = [];
    for (const prod of products) {
      const updated = await this.refreshProductPrices(prod);
      updatedProducts.push(updated);
    }

    productCache = {
      data: updatedProducts,
      lastUpdate: now
    };

    return updatedProducts;
  }

  /**
   * Helper to fetch active margin rules for a product.
   * Priority: Product -> Operator -> Category -> Provider -> Global
   */
  static async getMarginForProduct(product: Partial<IProduct>): Promise<IMarginSetting> {
    const margins = await DB.MarginSettings.find();

    // 1. Product Margin
    if (product.id) {
      const pMargin = margins.find(m => m.type === 'product' && m.target_id === product.id);
      if (pMargin) return pMargin;
    }

    // 2. Operator Margin
    const operatorName = product.brand || product.operator;
    if (operatorName) {
      const oMargin = margins.find(m => m.type === 'operator' && m.target_id.toLowerCase() === operatorName.toLowerCase());
      if (oMargin) return oMargin;
    }

    // 3. Category Margin
    if (product.category_id) {
      const cMargin = margins.find(m => m.type === 'category' && m.target_id === product.category_id);
      if (cMargin) return cMargin;
    }

    // 4. Provider Margin
    if (product.provider_id) {
      const prMargin = margins.find(m => m.type === 'provider' && m.target_id === product.provider_id);
      if (prMargin) return prMargin;
    }

    // 5. Global Margin
    const gMargin = margins.find(m => m.type === 'global');
    if (gMargin) return gMargin;

    // Hard fallback
    return {
      id: 'default',
      type: 'global',
      target_id: 'global',
      margin_umum: 1500,
      margin_member: 1000,
      margin_reseller: 800,
      margin_agen: 500,
      margin_type: 'flat'
    };
  }

  /**
   * Calculates prices based on a margin rule.
   */
  static calculatePrices(hargaModal: number, marginSetting: IMarginSetting) {
    let harga_umum = hargaModal;
    let harga_member = hargaModal;
    let harga_reseller = hargaModal;
    let harga_agen = hargaModal;

    if (marginSetting.margin_type === 'percent') {
      harga_umum = Math.round(hargaModal * (1 + marginSetting.margin_umum / 100));
      harga_member = Math.round(hargaModal * (1 + marginSetting.margin_member / 100));
      harga_reseller = Math.round(hargaModal * (1 + marginSetting.margin_reseller / 100));
      harga_agen = Math.round(hargaModal * (1 + marginSetting.margin_agen / 100));
    } else {
      harga_umum = hargaModal + marginSetting.margin_umum;
      harga_member = hargaModal + marginSetting.margin_member;
      harga_reseller = hargaModal + marginSetting.margin_reseller;
      harga_agen = hargaModal + marginSetting.margin_agen;
    }

    return {
      harga_umum,
      harga_member,
      harga_reseller,
      harga_agen,
      margin: harga_umum - hargaModal
    };
  }

  /**
   * Refreshes dynamic prices for a single product.
   */
  static async refreshProductPrices(product: IProduct): Promise<IProduct> {
    const marginSetting = await this.getMarginForProduct(product);
    const calcs = this.calculatePrices(product.harga_modal, marginSetting);

    const updatedData = {
      margin: calcs.margin,
      harga_jual: calcs.harga_umum,
      harga_umum: calcs.harga_umum,
      harga_member: calcs.harga_member,
      harga_reseller: calcs.harga_reseller,
      harga_agen: calcs.harga_agen
    };

    // Only update in DB if values have actually changed to reduce DB wear
    if (
      product.harga_jual !== updatedData.harga_jual ||
      product.harga_umum !== updatedData.harga_umum ||
      product.harga_member !== updatedData.harga_member ||
      product.harga_reseller !== updatedData.harga_reseller ||
      product.harga_agen !== updatedData.harga_agen
    ) {
      const res = await DB.Products.findByIdAndUpdate(product.id, updatedData);
      return res ? { ...product, ...updatedData } : product;
    }

    return { ...product, ...updatedData };
  }

  /**
   * Core Synchronizer Engine.
   * Syncs products from providers to the database.
   */
  static async syncProducts(filters: {
    providerId?: string;
    categoryId?: string;
    operator?: string;
    productCode?: string;
  }) {
    const results = {
      jumlah_baru: 0,
      jumlah_diperbarui: 0,
      jumlah_dinonaktifkan: 0,
      jumlah_gagal: 0,
      errors: [] as string[]
    };

    // Get active providers
    const allProviders = await DB.Providers.find();
    const targetProviders = allProviders.filter(p => {
      if (p.status !== 'aktif') return false;
      if (filters.providerId && p.id !== filters.providerId) return false;
      return p.code.toLowerCase() !== 'manual';
    });

    const allCategories = await DB.Categories.find();

    for (const provider of targetProviders) {
      try {
        console.log(`[ProductSyncEngine] Fetching products from provider: ${provider.nama}`);
        const providerProducts = await ProviderService.getProducts(provider.id);

        if (!Array.isArray(providerProducts)) {
          throw new Error('Provider returned non-array product list.');
        }

        const syncedCodes: string[] = [];

        for (const item of providerProducts) {
          // Filter checks
          if (filters.productCode && item.code !== filters.productCode) continue;
          if (filters.operator && item.brand.toLowerCase() !== filters.operator.toLowerCase()) continue;

          syncedCodes.push(item.code);

          // Find/create category
          let categoryId = 'cat-pulsa'; // default fallback
          if (filters.categoryId) {
            categoryId = filters.categoryId;
          } else {
            const matchedCat = allCategories.find(c => c.nama.toLowerCase() === item.category.toLowerCase());
            if (matchedCat) {
              categoryId = matchedCat.id;
            } else {
              // Create dynamic category
              const newCat = await DB.Categories.create({
                nama: item.category,
                icon: 'Zap',
                urutan: allCategories.length + 1,
                status: 'aktif'
              });
              allCategories.push(newCat);
              categoryId = newCat.id;
            }
          }

          // Get product margins & compute pricing
          const tempProduct: Partial<IProduct> = {
            category_id: categoryId,
            provider_id: provider.id,
            nama: item.name,
            kode_produk: item.code,
            harga_modal: item.price,
            brand: item.brand,
            operator: item.brand,
            jenis_paket: item.category
          };

          const marginSetting = await this.getMarginForProduct(tempProduct);
          const pricing = this.calculatePrices(item.price, marginSetting);

          // Search existing product in our DB
          const existingProducts = await DB.Products.find({
            provider_id: provider.id,
            kode_produk: item.code
          });

          if (existingProducts.length > 0) {
            const localProd = existingProducts[0];
            
            // Check changes
            const isChanged = 
              localProd.harga_modal !== item.price ||
              localProd.status !== (item.status === 'aktif' ? 'aktif' : 'nonaktif') ||
              localProd.nama !== item.name;

            if (isChanged) {
              await DB.Products.findByIdAndUpdate(localProd.id, {
                nama: item.name,
                harga_modal: item.price,
                harga_jual: pricing.harga_umum,
                harga_umum: pricing.harga_umum,
                harga_member: pricing.harga_member,
                harga_reseller: pricing.harga_reseller,
                harga_agen: pricing.harga_agen,
                margin: pricing.margin,
                status: item.status === 'aktif' ? 'aktif' : 'nonaktif',
                last_update: new Date().toISOString()
              });
              results.jumlah_diperbarui++;
            }
          } else {
            // Create brand new product
            await DB.Products.create({
              category_id: categoryId,
              provider_id: provider.id,
              nama: item.name,
              kode_produk: item.code,
              harga_modal: item.price,
              harga_jual: pricing.harga_umum,
              harga_umum: pricing.harga_umum,
              harga_member: pricing.harga_member,
              harga_reseller: pricing.harga_reseller,
              harga_agen: pricing.harga_agen,
              margin: pricing.margin,
              deskripsi: item.desc || `Layanan ${item.brand} dari provider ${provider.nama}`,
              status: item.status === 'aktif' ? 'aktif' : 'nonaktif',
              stok: 999,
              operator: item.brand,
              brand: item.brand,
              jenis_paket: item.category,
              gangguan: false,
              last_update: new Date().toISOString()
            });
            results.jumlah_baru++;
          }
        }

        // Section 2: disable products no longer returned by provider
        if (!filters.productCode && !filters.operator) {
          const localProductsForProvider = await DB.Products.find({ provider_id: provider.id });
          const missingProducts = localProductsForProvider.filter(p => !syncedCodes.includes(p.kode_produk));
          for (const missing of missingProducts) {
            if (missing.status === 'aktif') {
              await DB.Products.findByIdAndUpdate(missing.id, {
                status: 'nonaktif',
                gangguan: true,
                last_update: new Date().toISOString()
              });
              results.jumlah_dinonaktifkan++;
            }
          }
        }

      } catch (err: any) {
        results.jumlah_gagal++;
        results.errors.push(`Gagal sinkronisasi ${provider.nama}: ${err.message}`);
        console.error(`[ProductSyncEngine] Sync failure for provider ${provider.nama}:`, err);
      }
    }

    // Write audit activity log
    await DB.ActivityLogs.create({
      tipe_aktivitas: 'SINKRONISASI_PRODUK',
      deskripsi: `Sinkronisasi produk selesai. Baru: ${results.jumlah_baru}, Diperbarui: ${results.jumlah_diperbarui}, Dinonaktifkan: ${results.jumlah_dinonaktifkan}, Gagal Provider: ${results.jumlah_gagal}. Filter: ${JSON.stringify(filters)}`,
      user_id: 'usr-admin',
      ip_address: '127.0.0.1',
      user_agent: 'System Engine'
    });

    // Reset product cache to push updates immediately
    this.clearCache();

    return results;
  }
}
