
    import { createApp, ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { render } from './render.generated.js';

    createApp({
      render,
      setup() {
        const currentLang = ref('en');
        const postcards = ref([]);
        const loading = ref(false);
        const submitting = ref(false);
        const filterType = ref('ALL');
        const apiConnected = ref(false);

        // Pagination variables
        const pageSize = 30;
        const hasMore = ref(true);
        const loadingMore = ref(false);

        const showUploadModal = ref(false);
        const selectedPostcard = ref(null);

        const imageInputType = ref('file');

        // hCaptcha (the script is only downloaded when someone opens the Add Postcard window)
        const HCAPTCHA_SITEKEY = '59187592-c888-410a-a9ee-f92a10ccea82';
        const captchaToken = ref('');
        const captchaError = ref(false);
        let captchaWidget = null;
        let captchaScript = null;

        const loadCaptchaScript = () => {
          captchaScript ??= new Promise((resolve, reject) => {
            if (globalThis.hcaptcha) { resolve(); return; }
            const s = document.createElement('script');
            s.src = 'https://js.hcaptcha.com/1/api.js?render=explicit';
            s.async = true;
            s.addEventListener('load', () => resolve());
            s.addEventListener('error', () => { captchaScript = null; reject(new Error('hCaptcha script blocked')); });
            document.head.append(s);
          });
          return captchaScript;
        };

        const showCaptcha = async () => {
          captchaToken.value = '';
          captchaError.value = false;
          captchaWidget = null;
          if (!apiConnected.value) return;
          try {
            await Promise.all([loadCaptchaScript(), nextTick()]);
            const box = document.getElementById('hcaptcha-box');
            if (!box || !showUploadModal.value) return;
            captchaWidget = globalThis.hcaptcha.render(box, {
              sitekey: HCAPTCHA_SITEKEY,
              callback: (token) => { captchaToken.value = token; captchaError.value = false; },
              'expired-callback': () => { captchaToken.value = ''; },
              'error-callback': () => { captchaToken.value = ''; captchaError.value = true; }
            });
          } catch (err) {
            console.warn('Could not show the captcha.', err);
            captchaError.value = true;
          }
        };

        const resetCaptcha = () => {
          captchaToken.value = '';
          if (captchaWidget !== null && globalThis.hcaptcha) globalThis.hcaptcha.reset(captchaWidget);
        };
        const form = ref({
          title: '',
          sourceType: 'Flower',
          address: '',
          date: new Date().toISOString().split('T')[0],
          image: '',
          thumb: '',
          thumbSm: '',
          imageUrlInput: ''
        });

        const dictionary = {
          en: {
            appTitle: 'Pikmin Bloom',
            appSubtitle: 'Postcard Gallery Archive',
            addPostcardBtn: 'Add Postcard',
            totalCount: 'Total Postcards',
            apiLive: 'API Connected',
            apiLocalOnly: 'Local Storage Fallback',
            filterLabel: 'Filter Type',
            filterAll: 'All Types',
            typeFlower: 'Flower',
            typeMushroom: 'Mushroom Fight',
            refreshTooltip: 'Refresh Data',
            emptyStateTitle: 'This collection has no data',
            emptyStateDesc: 'There are no postcards logged yet. Click below to add your first postcard.',
            loading: 'Loading postcards...',
            viewDetails: 'View Details',
            formImageLabel: 'Postcard Image',
            uploadLocalFile: 'Local File',
            uploadImageUrl: 'Image URL',
            clickToChooseFile: 'Click to select image file from device',
            urlPlaceholder: 'https://example.com/postcard.jpg',
            livePreviewLabel: 'Live Image Preview',
            noPreviewAvailable: 'No image selected for preview',
            formTitleLabel: 'Title / Location Name',
            titlePlaceholder: 'e.g. Historic Clock Tower Flower',
            formTypeLabel: 'Source Type',
            formAddressLabel: 'Detailed Address',
            addressPlaceholder: 'e.g. 100 Main Street, San Francisco, CA',
            formDateLabel: 'Obtained Date',
            cancelBtn: 'Cancel',
            submitBtn: 'Save Postcard',
            captchaError: 'Please complete the "I am human" check.',
            closeBtn: 'Close',
            loadMoreBtn: 'Load More Postcards',
            loadingMoreText: 'Loading...',
            footerText: 'Pikmin Bloom Postcard Gallery Management System'
          },
          zh: {
            appTitle: '皮克敏 Bloom',
            appSubtitle: '皮克敏明信片圖鑑與典藏',
            addPostcardBtn: '新增明信片',
            totalCount: '明信片總數',
            apiLive: 'API 連線正常',
            apiLocalOnly: '離線快取模式',
            filterLabel: '篩選類別',
            filterAll: '全部類別',
            typeFlower: '大花朵 (Flower)',
            typeMushroom: '蘑菇戰 (Mushroom Fight)',
            refreshTooltip: '重新整理',
            emptyStateTitle: '尚無任何明信片資料',
            emptyStateDesc: '此集合目前沒有任何內容，請點擊下方按鈕上傳並建立第一張明信片。',
            loading: '載入明信片資料中...',
            viewDetails: '檢視細節',
            formImageLabel: '明信片圖片',
            uploadLocalFile: '本機檔案',
            uploadImageUrl: '圖片網址 URL',
            clickToChooseFile: '點擊選擇裝置中的圖片檔案',
            urlPlaceholder: 'https://example.com/postcard.jpg',
            livePreviewLabel: '實時圖片預覽 (Live Preview)',
            noPreviewAvailable: '尚未選擇或輸入圖片',
            formTitleLabel: '標題 / 地標名稱',
            titlePlaceholder: '例如：中央公園巨石大花朵',
            formTypeLabel: '來源類型',
            formAddressLabel: '詳細地址資訊',
            addressPlaceholder: '例如：台北市信義區信義路五段7號',
            formDateLabel: '獲得日期',
            cancelBtn: '取消',
            submitBtn: '儲存明信片',
            captchaError: '請先完成「我是人類」驗證。',
            closeBtn: '關閉',
            loadMoreBtn: '載入更多明信片',
            loadingMoreText: '載入中...',
            footerText: '皮克敏 Bloom 明信片管理與檢視系統'
          }
        };

        const t = (key) => dictionary[currentLang.value][key] || key;

        const toggleLang = () => {
          currentLang.value = currentLang.value === 'en' ? 'zh' : 'en';
        };
        watch(currentLang, (l) => { document.documentElement.lang = l === 'zh' ? 'zh-Hant' : 'en'; });
        const onKey = (e) => {
          if (e.key !== 'Escape') return;
          if (selectedPostcard.value) selectedPostcard.value = null;
          else if (showUploadModal.value) showUploadModal.value = false;
        };

        const filteredPostcards = computed(() => {
          if (filterType.value === 'ALL') return postcards.value;
          return postcards.value.filter(item => item.sourceType === filterType.value);
        });

        // Initial Fetch (First 30 items)
        const fetchPostcards = async () => {
          loading.value = true;
          try {
            let data = null;
            if (globalThis.__pcPromise) {
              const early = globalThis.__pcPromise;
              globalThis.__pcPromise = null;
              try { data = await early; } catch { data = null; /* the early request failed: ask again below */ }
            }
            if (!data) {
              const res = await fetch(`/api/postcards?limit=${pageSize}&skip=0`);
              if (!res.ok) throw new Error('API return non-200 status');
              data = await res.json();
            }
            postcards.value = data;
            hasMore.value = data.length === pageSize;
            apiConnected.value = true;
          } catch (error) {
            console.warn('Could not load postcards from the API; using the saved copy.', error);
            apiConnected.value = false;
            const local = localStorage.getItem('pb_postcards');
            if (local) {
              try {
                postcards.value = JSON.parse(local);
              } catch {
                postcards.value = [];
              }
            } else {
              postcards.value = [];
            }
          } finally {
            loading.value = false;
          }
        };

        // Load Next 30 Items
        const loadMorePostcards = async () => {
          if (loadingMore.value || !hasMore.value) return;
          loadingMore.value = true;

          try {
            const skipCount = postcards.value.length;
            const res = await fetch(`/api/postcards?limit=${pageSize}&skip=${skipCount}`);
            if (res.ok) {
              const data = await res.json();
              if (data.length > 0) {
                postcards.value.push(...data);
              }
              if (data.length < pageSize) {
                hasMore.value = false;
              }
            }
          } catch (err) {
            console.error('Failed to load more postcards', err);
          } finally {
            loadingMore.value = false;
          }
        };

        const openUploadModal = () => {
          form.value = {
            title: '',
            sourceType: 'Flower',
            address: '',
            date: new Date().toISOString().split('T')[0],
            image: '',
            thumb: '',
          thumbSm: '',
            imageUrlInput: ''
          };
          imageInputType.value = 'file';
          showUploadModal.value = true;
          void showCaptcha();
        };

        const closeUploadModal = () => {
          showUploadModal.value = false;
        };

        // Resize with a canvas and encode as WebP (longest side <= max)
        const resizeToWebp = (img, max, quality) => {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL('image/webp', quality);
        };

        // Full image (1200px) for the details view + small thumbnail (480px) for the grid cards
        const handleFileChange = (e) => {
          const file = e.target.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.addEventListener('load', (event) => {
            const img = new Image();
            img.addEventListener('load', () => {
              form.value.image = resizeToWebp(img, 1200, 0.8);
              form.value.thumb = resizeToWebp(img, 480, 0.72);
              form.value.thumbSm = resizeToWebp(img, 320, 0.7);
            });
            img.src = event.target.result;
          });
          reader.readAsDataURL(file);
        };

        const handleUrlInput = () => {
          form.value.image = form.value.imageUrlInput;
          form.value.thumb = '';
          form.value.thumbSm = '';
        };

        // A picture failed to load: show a placeholder instead. The srcset must be removed too,
        // otherwise the browser picks the broken picture again and the error repeats forever.
        const handleImageError = (e) => {
          const img = e.target;
          if (img.dataset.failed) return;
          img.dataset.failed = '1';
          img.removeAttribute('srcset');
          img.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="none" stroke="%2394a3b8" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
        };

        const submitPostcard = async () => {
          if (!form.value.title || !form.value.address || !form.value.image) return;
          if (apiConnected.value && !captchaToken.value) { captchaError.value = true; return; }

          submitting.value = true;

          const payload = {
            title: form.value.title,
            sourceType: form.value.sourceType,
            address: form.value.address,
            date: form.value.date,
            image: form.value.image,
            thumb: form.value.thumb || undefined,
            thumbSm: form.value.thumbSm || undefined,
            captchaToken: apiConnected.value ? captchaToken.value : undefined
          };

          try {
            if (apiConnected.value) {
              const res = await fetch('/api/postcards', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
              });
              if (res.ok) {
                await fetchPostcards();
              } else {
                throw new Error('Save failed');
              }
            } else {
              const newEntry = { _id: 'local_' + Date.now(), ...payload };
              postcards.value.unshift(newEntry);
              localStorage.setItem('pb_postcards', JSON.stringify(postcards.value));
            }
            closeUploadModal();
          } catch (error) {
            console.error('Saving the postcard failed.', error);
            resetCaptcha(); // a captcha answer works only once
            alert('儲存明信片失敗。');
          } finally {
            submitting.value = false;
          }
        };

        // Offer the browser two grid picture sizes; it downloads the one that fits the screen.
        const thumbSrcset = (item) =>
          item.thumb && item.thumbSm ? `${item.thumbSm} 320w, ${item.thumb} 480w` : undefined;

        const openDetailsModal = (item) => {
          selectedPostcard.value = item;
        };

        onMounted(() => {
          void fetchPostcards();
          globalThis.addEventListener('keydown', onKey);
        });
        onBeforeUnmount(() => globalThis.removeEventListener('keydown', onKey));

        return {
          currentLang,
          t,
          toggleLang,
          postcards,
          filteredPostcards,
          loading,
          submitting,
          filterType,
          apiConnected,
          hasMore,
          loadingMore,
          showUploadModal,
          selectedPostcard,
          imageInputType,
          captchaToken,
          captchaError,
          form,
          openUploadModal,
          closeUploadModal,
          handleFileChange,
          handleUrlInput,
          handleImageError,
          submitPostcard,
          loadMorePostcards,
          openDetailsModal,
thumbSrcset,
          fetchPostcards
        };
      }
    }).mount('#app');
  