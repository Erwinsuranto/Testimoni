Saya telah menyelesaikan implementasi perbaikan sistem sinkronisasi Digiflazz untuk menangani pembatasan (RC 83) secara anggun tanpa menyebabkan kegagalan total sistem. Seluruh kode telah diuji, dikompilasi, dan divalidasi dengan sukses (lint dan build berhasil).
Berikut adalah detail perubahan yang telah dilakukan:
1. File yang Diedit
server/providers/digiflazz/index.ts
server/providers/sync-engine.ts
2. Fungsi yang Diubah
server/providers/digiflazz/index.ts (Fungsi getProducts):
Mengubah penanganan ketika respons API mengandung kode balasan rc bernilai "83" (atau pesan limitasi).
Alih-alih menganggap ini sebagai error yang merusak alur eksekusi, fungsi ini sekarang mendeteksi kondisi limitasi tersebut secara eksplisit, menampilkan log terstruktur sesuai instruksi, dan langsung mengembalikan objek status limitasi:
code
TypeScript
{
  success: false,
  limited: true,
  rc: "83",
  message: "Limit pricelist Digiflazz. Produk lama tetap digunakan."
}
server/providers/sync-engine.ts (Fungsi syncProducts):
Mengubah cara penanganan hasil dari ProviderService.getProducts().
Jika fungsi tersebut mengembalikan objek status limitasi (limited === true):
Proses update database dihentikan secara aman untuk provider yang bersangkutan.
Tidak ada penghapusan produk lama dari database.
Tidak ada pembersihan cache (clear cache) produk yang aktif.
Sistem melompati sisa iterasi pembaruan produk untuk provider tersebut dan mencatat pesan bahwa sinkronisasi dilewati karena limitasi.
3. Alasan Perubahan
Penanganan Respons Limitasi Secara Anggun: Sebelumnya, respons pembatasan rate limit (rc = 83) dari Digiflazz dianggap sebagai kegagalan HTTP/koneksi biasa sehingga memicu throw error yang membatalkan seluruh alur sinkronisasi. Dengan perubahan ini, sistem mengenali bahwa request berhasil mencapai tujuan namun dibatasi secara sengaja, sehingga data yang sudah ada di database aman dari perubahan atau penghapusan tak terduga.
Pencegahan Inkonsistensi Data: Menambahkan perlindungan agar database produk lama tidak dihapus atau ditulis ulang (overwrite) dengan data kosong/rusak saat limitasi terjadi.
Log Sistem yang Jelas: Mempermudah pemantauan operasional dengan menambahkan log terstruktur berikut di server ketika limitasi terdeteksi:
code
Text
[DIGIFLAZZ]
RC = 83
Limit Pricelist
Menggunakan produk lama
Sinkronisasi dilewati
