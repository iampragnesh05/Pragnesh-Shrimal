/**
 * ============================================================================
 * Product Grid Popup — Interactive Hotspot Modal
 * ============================================================================
 * Manages a single-shared popup instance for all products in custom-product-grid.
 * Handles:
 *  • Dynamic population from hotspot data-attributes
 *  • Color pill selection (grid layout)
 *  • Custom size dropdown (NOT native <select>)
 *  • Variant syncing with price updates
 *  • Add-to-cart with special Black+Medium rule
 *  • Toast notifications
 *  • Responsive mobile bottom-sheet on ≤600px
 *  • Keyboard dismiss (Escape), backdrop click, focus management
 *
 * No jQuery — 100% vanilla JS, Pointer Events API for interactions.
 * ============================================================================
 */

(function () {
  'use strict';

  /* =========================================================================
     DOM REFERENCES
     ========================================================================= */

  const popup = document.getElementById('pg-popup');
  const backdrop = document.getElementById('pgp-bd');
  const closeBtn = document.getElementById('pgp-close');
  const popImg = document.getElementById('pgp-img');
  const popTitle = document.getElementById('pgp-title');
  const popPrice = document.getElementById('pgp-price');
  const popDesc = document.getElementById('pgp-desc');
  const controls = document.getElementById('pgp-controls');
  const atcBtn = document.getElementById('pgp-atc');
  const atcLabel = atcBtn.querySelector('.pgp__atc-label');
  const fb = document.getElementById('pgp-fb');

  /* =========================================================================
     STATE
     ========================================================================= */

  let allVariants = []; // full variant array for open product
  let selectedOpts = {}; // { "Color": "Blue", "Size": "M" }
  let activeHandle = ''; // product handle for special rule lookup
  let closingPopupFocus = null; // element to restore focus to when closing
  let optionMap = {}; // maps option name to its position (e.g., { "Size": 1, "Color": 2 })
  const BONUS_JACKET_HANDLE = 'soft-winter-jacket';
  const BONUS_JACKET_TITLE = 'Soft Winter Jacket';
  const BONUS_DEBUG = true;

  /* =========================================================================
     HELPERS
     ========================================================================= */

  /**
   * Decode HTML entities from data-attributes.
   * Liquid escapes JSON in HTML attributes with &quot;, &#x2F;, etc.
   * We unescape using a textarea's innerHTML property.
   */
  function htmlDecode(str) {
    const txt = document.createElement('textarea');
    txt.innerHTML = str;
    return txt.value;
  }

  /**
   * Format a Shopify price (in cents) to a display string.
   * Tries Shopify.formatMoney first, falls back to manual EUR format.
   */
  function formatMoney(cents) {
    if (typeof Shopify !== 'undefined' && Shopify.formatMoney) {
      return Shopify.formatMoney(cents, '{{ shop.money_format }}');
    }
    // Fallback: EUR format
    const euros = (cents / 100).toFixed(2);
    return '€' + euros.replace('.', ',');
  }

  /**
   * Fetch the first available variant ID for a product by handle.
   * Used for the "Soft Winter Jacket" auto-add on Black+Medium.
   */
  async function getFirstVariantId(handle) {
    try {
      const res = await fetch('/products/' + handle + '.js');
      if (!res.ok) return null;
      const data = await res.json();
      // Prefer available variant, fall back to first
      const variant =
        data.variants.find(function (v) {
          return v.available;
        }) || data.variants[0];
      return variant ? variant.id : null;
    } catch (err) {
      console.warn('Failed to fetch variant for ' + handle, err);
      return null;
    }
  }

  /**
   * Fallback: find a product by title via predictive search
   * and return its first available variant id.
   * Useful when the product handle is different from expectation.
   */
  async function getFirstVariantIdByTitle(title) {
    try {
      const searchUrl =
        '/search/suggest.json?q=' +
        encodeURIComponent(title) +
        '&resources[type]=product&resources[limit]=10&section_id=predictive-search';
      const searchRes = await fetch(searchUrl);
      if (!searchRes.ok) return null;
      const searchData = await searchRes.json();
      const products =
        searchData &&
        searchData.resources &&
        searchData.resources.results &&
        searchData.resources.results.products
          ? searchData.resources.results.products
          : [];

      if (!products.length) return null;

      const normalizedTarget = title.trim().toLowerCase();
      const exactMatch = products.find(function (p) {
        return String(p.title || '').trim().toLowerCase() === normalizedTarget;
      });
      const firstMatch = exactMatch || products[0];
      if (!firstMatch || !firstMatch.handle) return null;

      return await getFirstVariantId(firstMatch.handle);
    } catch (err) {
      console.warn('Failed predictive search lookup for ' + title, err);
      return null;
    }
  }

  /**
   * Refresh the cart item count in the header.
   * Updates all [data-cart-count], .cart-count, .js-cart-count, #CartCount elements.
   * Called after successful ATC.
   */
  function updateCartBubble() {
    fetch('/cart.js')
      .then(function (res) {
        return res.json();
      })
      .then(function (cart) {
        document.querySelectorAll(
          '[data-cart-count], .cart-count, .js-cart-count, #CartCount'
        ).forEach(function (el) {
          el.textContent = cart.item_count;
        });
      })
      .catch(function (err) {
        console.warn('Failed to update cart bubble', err);
      });
  }

  /**
   * Show a toast notification.
   * Appears for 3 seconds, auto-dismisses.
   */
  function showToast(message) {
    // Create toast element if it doesn't exist
    let toast = document.getElementById('pgp-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'pgp-toast';
      toast.className = 'pgp-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      document.body.appendChild(toast);

      // Add inline styles for toast (since it's appended to body, not in section styles)
      const style = document.createElement('style');
      style.textContent = `
        .pgp-toast {
          position: fixed;
          top: 24px;
          left: 50%;
          transform: translateX(-50%);
          background: #111;
          color: #fff;
          padding: 12px 24px;
          border-radius: 3px;
          font-size: 0.85rem;
          font-weight: 600;
          z-index: 99999;
          opacity: 0;
          transition: opacity 0.3s ease;
          pointer-events: none;
          max-width: 500px;
        }
        .pgp-toast.is-show {
          opacity: 1;
          pointer-events: all;
        }
      `;
      document.head.appendChild(style);
    }

    toast.textContent = message;
    toast.classList.add('is-show');

    // Auto-dismiss after 3 seconds
    setTimeout(function () {
      toast.classList.remove('is-show');
    }, 3000);
  }

  function showDebug(message) {
    if (!BONUS_DEBUG) return;
    console.log('[BONUS DEBUG] ' + message);
    showToast('[DEBUG] ' + message);
  }

  /**
   * Check if viewport is mobile breakpoint (≤600px).
   */
  function isMobileBreakpoint() {
    return window.innerWidth <= 600;
  }

  /* =========================================================================
     POPUP LIFECYCLE
     ========================================================================= */

  /**
   * Open popup, populate from hotspot button data-attributes.
   * Stores which button was clicked so we can restore focus on close.
   */
  function openPopup(btn) {
    closingPopupFocus = btn;

    // Reset UI state
    selectedOpts = {};
    fb.textContent = '';
    fb.classList.remove('is-err');
    atcLabel.textContent = 'ADD TO CART';
    atcBtn.disabled = false;

    // Populate from data-attributes
    popImg.src = btn.dataset.img;
    popImg.alt = btn.dataset.title;
    popTitle.textContent = btn.dataset.title;
    popPrice.textContent = btn.dataset.price;
    popDesc.textContent = btn.dataset.desc;
    activeHandle = btn.dataset.handle;

    // Parse variant data (HTML-escaped JSON from Liquid)
    try {
      allVariants = JSON.parse(htmlDecode(btn.dataset.variants));
      const options = JSON.parse(htmlDecode(btn.dataset.options));
      
      console.log('🎯 Popup Opened:', {
        title: btn.dataset.title,
        variantCount: allVariants.length,
        optionsCount: options.length,
        variants: allVariants,
        options: options
      });

      // Build variant controls (inside try so options is accessible)
      buildControls(options);

      // Show popup with accessibility updates
      popup.setAttribute('aria-hidden', 'false');
      popup.classList.add('is-open');
      document.body.style.overflow = 'hidden';

      // Focus close button for keyboard users
      closeBtn.focus();

      // Mobile: scroll popup to top so close button is visible
      if (isMobileBreakpoint()) {
        const box = popup.querySelector('.pgp__box');
        if (box) {
          box.scrollTop = 0;
        }
      }
    } catch (e) {
      console.error('❌ Failed to parse variant data:', e);
      fb.textContent = 'Error loading product data.';
      fb.classList.add('is-err');
      return;
    }
  }

  /**
   * Close popup, restore focus to the hotspot that opened it.
   */
  function closePopup() {
    popup.classList.remove('is-open');
    popup.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';

    // Restore focus to hotspot
    if (closingPopupFocus && closingPopupFocus.focus) {
      closingPopupFocus.focus();
    }
    closingPopupFocus = null;
  }

  /* =========================================================================
     BUILD VARIANT CONTROLS — Color pills + Size dropdown
     =========================================================================
     Logic:
       • "Color" (or any non-Size option) → pill buttons in grid layout
       • "Size" → custom dropdown (NOT native <select>)
  */

  function buildControls(options) {
    console.log('🛠️ Building controls for options:', options);
    
    // Build optionMap: maps option name to its position in variants
    // Example: if "Size" is the first option, optionMap.Size = 1
    optionMap = {};
    options.forEach(function (opt, idx) {
      optionMap[opt.name] = idx + 1;  // option1, option2, option3 are 1-indexed
    });
    console.log('🗺️ Option Map:', optionMap);
    
    controls.innerHTML = '';

    options.forEach(function (opt) {
      console.log(`  📋 Building option group: ${opt.name}`, opt.values);
      
      const group = document.createElement('div');
      group.className = 'pgp-opt';

      // Label (e.g. "Color", "Size")
      const label = document.createElement('span');
      label.className = 'pgp-opt__label';
      label.textContent = opt.name;
      group.appendChild(label);

      if (opt.name.toLowerCase() === 'size') {
        // Size → Custom dropdown
        group.appendChild(buildSizeDropdown(opt));
      } else {
        // Other options → Pill buttons in grid
        group.appendChild(buildPills(opt));
      }

      controls.appendChild(group);
    });

    // Pre-sync variant on initial build (so first color is selected)
    console.log('⏳ Pre-syncing variant after build...');
    syncVariant();
  }

  /**
   * Build a grid of color pills.
   * Layout: grid 1fr 1fr for 2-column layout matching Figma.
   * Wrapper has border around both pills.
   */
  function buildPills(opt) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pgp-pills-wrapper';

    const row = document.createElement('div');
    row.className = 'pgp-opt__pills';

    opt.values.forEach(function (val, idx) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'pgp-pill';
      pill.textContent = val;
      pill.dataset.opt = opt.name;
      pill.dataset.val = val;

      // Pre-select first pill
      if (idx === 0) {
        pill.classList.add('is-sel');
        selectedOpts[opt.name] = val;
      }

      pill.addEventListener('click', function (e) {
        e.preventDefault();
        console.log('🎨 Color pill clicked:', val);
        
        // Deselect all pills in this group
        row.querySelectorAll('.pgp-pill').forEach(function (p) {
          p.classList.remove('is-sel');
        });
        // Select clicked pill
        pill.classList.add('is-sel');
        selectedOpts[opt.name] = val;
        
        console.log('📌 Updated selectedOpts:', selectedOpts);
        
        // Clear error message
        fb.textContent = '';
        fb.classList.remove('is-err');
        // Update price and ATC state
        syncVariant();
      });

      row.appendChild(pill);
    });

    wrapper.appendChild(row);
    return wrapper;
  }

  /**
   * Build a custom size dropdown (NOT native <select>).
   * Structure:
   *   • Trigger button showing current value + chevron
   *   • Hidden list that shows on .is-open
   *   • List items are buttons
   *   • Click outside or Escape to close
   */
  function buildSizeDropdown(opt) {
    const wrap = document.createElement('div');
    wrap.className = 'pgp-size-wrap';

    // Trigger button
    const trigger = document.createElement('button');
    trigger.className = 'pgp-size-trigger';
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const triggerText = document.createElement('span');
    triggerText.className = 'pgp-size-trigger__text';
    triggerText.textContent = 'Choose your size';
    trigger.appendChild(triggerText);

    const chevron = document.createElement('span');
    chevron.className = 'pgp-size-trigger__chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '▼';
    trigger.appendChild(chevron);

    wrap.appendChild(trigger);

    // Hidden list of options
    const list = document.createElement('div');
    list.className = 'pgp-size-list';
    list.setAttribute('role', 'listbox');
    list.style.display = 'none'; // hidden until opened

    opt.values.forEach(function (val) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'pgp-size-item';
      item.textContent = val;
      item.setAttribute('role', 'option');
      item.dataset.val = val;

      item.addEventListener('click', function (e) {
        e.preventDefault();
        console.log('📏 Size selected:', val);
        
        // Update trigger text
        triggerText.textContent = val;
        // Update selected options
        selectedOpts[opt.name] = val;
        
        console.log('📌 Updated selectedOpts:', selectedOpts);
        
        // Close dropdown
        trigger.setAttribute('aria-expanded', 'false');
        list.style.display = 'none';
        wrap.classList.remove('is-open');
        // Clear error
        fb.textContent = '';
        fb.classList.remove('is-err');
        // Sync variant
        syncVariant();
        // Return focus to trigger
        trigger.focus();
      });

      list.appendChild(item);
    });

    wrap.appendChild(list);

    // Trigger button click → toggle dropdown
    trigger.addEventListener('click', function (e) {
      e.preventDefault();
      const isOpen = wrap.classList.contains('is-open');

      if (!isOpen) {
        // Open dropdown
        wrap.classList.add('is-open');
        list.style.display = 'flex';
        trigger.setAttribute('aria-expanded', 'true');
      } else {
        // Close dropdown
        wrap.classList.remove('is-open');
        list.style.display = 'none';
        trigger.setAttribute('aria-expanded', 'false');
      }
    });

    // Close on Escape
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && wrap.classList.contains('is-open')) {
        wrap.classList.remove('is-open');
        list.style.display = 'none';
        trigger.setAttribute('aria-expanded', 'false');
      }
    });

    // Close on click outside
    document.addEventListener('click', function (e) {
      if (wrap.classList.contains('is-open') && !wrap.contains(e.target)) {
        wrap.classList.remove('is-open');
        list.style.display = 'none';
        trigger.setAttribute('aria-expanded', 'false');
      }
    });

    return wrap;
  }

  /* =========================================================================
     VARIANT SYNCING
     ========================================================================= */

  /**
   * Match current selectedOpts to a variant.
   * Updates displayed price and ATC button state.
   */
  function syncVariant() {
    const match = findMatchingVariant();

    console.log('🔄 Syncing variant:', {
      selectedOpts: selectedOpts,
      matchFound: !!match,
      variant: match,
      allVariants: allVariants
    });

    if (match) {
      popPrice.textContent = formatMoney(match.price);
      atcBtn.dataset.variantId = String(match.id);
      atcBtn.disabled = !match.available;
      atcLabel.textContent = match.available ? 'ADD TO CART' : 'SOLD OUT';
      
      console.log('✅ Variant matched:', {
        id: match.id,
        price: match.price,
        available: match.available,
        options: {
          option1: match.option1,
          option2: match.option2,
          option3: match.option3
        }
      });
    } else {
      // Partial selection — no exact match yet
      atcBtn.dataset.variantId = '';
      atcBtn.disabled = true;
      
      console.log('⚠️ No variant match found yet');
    }
  }

  /**
   * Find variant by matching all selectedOpts to variant option1/option2/option3.
   * Uses optionMap to determine which position each option name is at.
   */
  function findMatchingVariant() {
    const optKeys = Object.keys(selectedOpts);
    if (optKeys.length === 0) return null;

    console.log('🔍 Finding variant. Selected options:', optKeys, selectedOpts);
    console.log('   Using optionMap:', optionMap);

    const match = allVariants.find(function (v) {
      const matches = optKeys.every(function (optName) {
        const position = optionMap[optName];  // Get position (1, 2, or 3)
        const optionKey = 'option' + position;
        const variantValue = v[optionKey];
        const selectedValue = selectedOpts[optName];
        
        console.log(`  Comparing ${optionKey}: "${variantValue}" === "${selectedValue}" ? ${variantValue === selectedValue}`);
        
        return variantValue === selectedValue;
      });
      return matches;
    });

    return match;
  }

  /* =========================================================================
     ADD TO CART with special Black+Medium rule
     ========================================================================= */

  atcBtn.addEventListener('click', async function () {
    const variantId = parseInt(atcBtn.dataset.variantId, 10);

    console.log('🛒 ATC clicked. Variant ID:', variantId);

    // Guard: no variant selected
    if (!variantId) {
      console.log('❌ No variant selected. Disabled button clicked.');
      fb.textContent = 'Please select all options first.';
      fb.classList.add('is-err');
      return;
    }

    console.log('✅ Valid variant. Proceeding with ATC...');

    // Disable button while processing
    atcBtn.disabled = true;
    atcLabel.textContent = 'Adding…';

    try {
      // Build items array
      const items = [{ id: variantId, quantity: 1 }];

      // ── Special rule ──────────────────────────────────────────
      // If selected variant has BOTH "Black" AND "Medium",
      // also add the "Soft Winter Jacket" first available variant.
      // ──────────────────────────────────────────────────────────
      const selectedColor = Object.keys(selectedOpts).find(function (key) {
        return key.toLowerCase() === 'color';
      });
      const selectedSize = Object.keys(selectedOpts).find(function (key) {
        return key.toLowerCase() === 'size';
      });

      const colorValue = selectedColor ? String(selectedOpts[selectedColor]).toLowerCase() : '';
      const sizeValue = selectedSize ? String(selectedOpts[selectedSize]).toLowerCase() : '';

      const hasBlack = colorValue === 'black';
      const hasMedium = sizeValue === 'medium' || sizeValue === 'm';

      console.log('📋 ATC Details:', { variantId, selectedOpts, hasBlack, hasMedium });
      showDebug(
        'Condition check -> color="' +
          colorValue +
          '", size="' +
          sizeValue +
          '", pass=' +
          String(hasBlack && hasMedium)
      );

      let jacketMessage = '';
      if (hasBlack && hasMedium && activeHandle !== BONUS_JACKET_HANDLE) {
        console.log('🎁 Black+Medium detected. Fetching Soft Winter Jacket...');
        showDebug('Trying handle: ' + BONUS_JACKET_HANDLE);
        let jacketId = await getFirstVariantId(BONUS_JACKET_HANDLE);
        if (!jacketId) {
          showDebug('Handle lookup failed. Trying title: ' + BONUS_JACKET_TITLE);
          jacketId = await getFirstVariantIdByTitle(BONUS_JACKET_TITLE);
        }
        if (jacketId) {
          items.push({ id: jacketId, quantity: 1 });
          jacketMessage = ' Soft Winter Jacket also added.';
          console.log('✅ Jacket variant added:', jacketId);
          showDebug('Resolved jacket variant id: ' + String(jacketId));
        } else {
          console.warn('⚠️ Could not resolve Soft Winter Jacket variant id.');
          showDebug('Could not resolve Soft Winter Jacket variant id');
        }
      } else if (hasBlack && hasMedium && activeHandle === BONUS_JACKET_HANDLE) {
        showDebug('Skipped bonus add because active product is Soft Winter Jacket');
      } else {
        showDebug('Condition failed, bonus not attempted');
      }

      // ── POST to Shopify /cart/add.js ──
      console.log('📤 Posting to /cart/add.js:', { items });
      
      const res = await fetch('/cart/add.js', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ items: items })
      });

      if (!res.ok) {
        const errData = await res.json().catch(function () {
          return { description: 'Unable to add to cart' };
        });
        throw new Error(errData.description || 'Could not add to cart.');
      }

      // ── Success ──
      console.log('🎉 Successfully added to cart!');
      atcLabel.textContent = 'ADDED ✓';
      showToast('Successfully added to cart!' + jacketMessage);
      updateCartBubble();

      // Re-enable after 2.8 seconds
      setTimeout(function () {
        atcBtn.disabled = false;
        atcLabel.textContent = 'ADD TO CART';
      }, 2800);

    } catch (err) {
      console.error('🔴 ATC Error:', err);
      fb.textContent = err.message || 'Something went wrong. Please try again.';
      fb.classList.add('is-err');
      atcBtn.disabled = false;
      atcLabel.textContent = 'ADD TO CART';
    }
  });

  /* =========================================================================
     POPUP OPEN/CLOSE EVENTS
     ========================================================================= */

  // Open: click hotspot button
  document.addEventListener('click', function (e) {
    if (e.target.classList.contains('pg__dot') && !e.target.disabled) {
      openPopup(e.target);
    }
  });

  // Close: close button
  closeBtn.addEventListener('click', closePopup);

  // Close: backdrop click
  backdrop.addEventListener('click', closePopup);

  // Close: Escape key (also handled in dropdown, but here for popup itself)
  document.addEventListener('keydown', function (e) {
    if (
      e.key === 'Escape' &&
      popup.classList.contains('is-open')
    ) {
      closePopup();
    }
  });

})();
