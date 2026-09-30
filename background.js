// Finds emails and Instagram / Facebook / LinkedIn links for the scraped
// businesses by visiting their websites. Runs here in the background so it
// keeps going when the popup is closed. No API is used.

var running = false;
var renderWindowId = null;

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message && message.type === 'findContacts') {
        if (!running) {
            running = true;
            findContacts().catch(function(error) {
                return setProgress({ running: false, text: 'Stopped: ' + error.message });
            }).then(function() {
                running = false;
                return closeRenderWindow();
            });
        }
        sendResponse({ started: true });
    }
});

// Clear a stale "running" flag if the browser was closed mid-run
chrome.runtime.onStartup.addListener(function() {
    chrome.storage.local.set({ progress: null });
});

function setProgress(progress) {
    return chrome.storage.local.set({ progress: progress });
}

function findContacts() {
    return chrome.storage.local.get('results').then(function(data) {
        var results = (data && data.results) || [];
        var todo = results.filter(function(item) { return item.companyUrl && !item.contactsChecked; });
        var done = 0;
        var next = 0;
        var renderQueue = Promise.resolve();

        // Browser rendering (for JavaScript sites and bot-protected sites)
        // happens one site at a time
        function renderOneAtATime(url) {
            var result = renderQueue.then(function() { return renderPage(url); });
            renderQueue = result.catch(function() {});
            return result;
        }

        function save() {
            return chrome.storage.local.set({ results: results });
        }

        function worker() {
            if (next >= todo.length) return Promise.resolve();
            var item = todo[next++];
            return getContactInfo(item.companyUrl, renderOneAtATime).then(function(info) {
                item.email = info.emails.join('; ');
                item.instagram = info.instagram;
                item.facebook = info.facebook;
                item.linkedin = info.linkedin;
            }).catch(function() {}).then(function() {
                item.contactsChecked = true;
                done++;
                return Promise.all([
                    save(),
                    setProgress({ running: true, text: 'Checking websites: ' + done + ' of ' + todo.length + '...' })
                ]);
            }).then(worker);
        }

        if (!todo.length) {
            return setProgress({ running: false, text: 'All websites already checked.' });
        }
        return setProgress({ running: true, text: 'Checking websites: 0 of ' + todo.length + '...' }).then(function() {
            var workers = [];
            for (var i = 0; i < 4; i++) workers.push(worker());
            return Promise.all(workers);
        }).then(function() {
            var emails = results.filter(function(item) { return item.email; }).length;
            var socials = results.filter(function(item) { return item.instagram || item.facebook || item.linkedin; }).length;
            return setProgress({
                running: false,
                text: 'Done. Found emails for ' + emails + ' and social links for ' + socials + ' of ' + results.length + ' businesses.'
            });
        });
    });
}

// ---------- Collecting contact info for one website ----------

function getContactInfo(website, render) {
    var info = { emails: [], instagram: '', facebook: '', linkedin: '' };

    // The "website" on Google is often the business's own social page
    addSocials(info, [website]);
    if (isSocialUrl(website)) {
        return Promise.resolve(info);
    }

    function scan(page) {
        extractEmails(page.html).forEach(function(email) {
            if (info.emails.indexOf(email) === -1) info.emails.push(email);
        });
        addSocials(info, findSocialUrls(page.html));
        return page;
    }

    function hasAll() {
        return info.emails.length && info.instagram && info.facebook && info.linkedin;
    }

    function hasSomething() {
        return info.emails.length || info.instagram || info.facebook || info.linkedin;
    }

    var visited = {};

    return fetchPage(website).catch(function() {
        return null;
    }).then(function(home) {
        if (home && !looksBlocked(home.html)) {
            scan(home);
            visited[home.url] = true;
        } else {
            home = null;
        }

        // Nothing found in the plain HTML: load the site in a real browser
        // tab so JavaScript-built sites (Wix, React, ...) show their links
        if (!hasSomething()) {
            return render(website).then(function(rendered) {
                scan(rendered);
                visited[rendered.url] = true;
                return rendered;
            }, function() {
                return home;
            });
        }
        return home;
    }).then(function(home) {
        if (!home || hasAll()) return info;

        // Look for missing details on up to 2 contact/about pages
        var pages = findContactPages(home).filter(function(url) { return !visited[url]; }).slice(0, 2);
        return pages.reduce(function(chain, url) {
            return chain.then(function() {
                if (hasAll()) return;
                return fetchPage(url).then(function(page) {
                    if (!looksBlocked(page.html)) scan(page);
                }, function() {});
            });
        }, Promise.resolve()).then(function() { return info; });
    });
}

function addSocials(info, urls) {
    urls.forEach(function(url) {
        var type = socialType(url);
        if (type && !info[type]) info[type] = url;
    });
}

// ---------- Fetching and rendering pages ----------

function fetchPage(url) {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 12000);
    return fetch(url, { signal: controller.signal, credentials: 'omit', redirect: 'follow' }).then(function(response) {
        var type = response.headers.get('content-type') || '';
        if (!response.ok || type.indexOf('html') === -1) throw new Error('Not an HTML page');
        return response.text().then(function(html) {
            clearTimeout(timer);
            return { url: response.url || url, html: html };
        });
    }).catch(function(error) {
        clearTimeout(timer);
        throw error;
    });
}

// Pages that are a bot check instead of the real website
function looksBlocked(html) {
    return html.length < 600 ||
        /cf-browser-verification|challenge-platform|Just a moment\.\.\.|Attention Required! \| Cloudflare|enable JavaScript and cookies to continue/i.test(html);
}

// Open the page in a minimized background window, let its JavaScript run,
// then read the finished HTML
function renderPage(url) {
    return getRenderWindow().then(function(windowId) {
        return chrome.tabs.create({ windowId: windowId, url: url, active: false });
    }).then(function(tab) {
        return waitForLoad(tab.id, 20000).then(function() {
            return delay(2000);
        }).then(function() {
            return chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: function() {
                    return { url: location.href, html: document.documentElement.outerHTML };
                }
            });
        }).then(function(results) {
            closeTab(tab.id);
            if (!results || !results[0] || !results[0].result) throw new Error('Could not read page');
            return results[0].result;
        }, function(error) {
            closeTab(tab.id);
            throw error;
        });
    });
}

function getRenderWindow() {
    if (renderWindowId !== null) {
        return chrome.windows.get(renderWindowId).then(function() {
            return renderWindowId;
        }, function() {
            renderWindowId = null;
            return getRenderWindow();
        });
    }
    return chrome.windows.create({ url: 'about:blank', state: 'minimized', focused: false }).then(function(win) {
        renderWindowId = win.id;
        return win.id;
    });
}

function closeRenderWindow() {
    if (renderWindowId === null) return Promise.resolve();
    var id = renderWindowId;
    renderWindowId = null;
    return chrome.windows.remove(id).catch(function() {});
}

function closeTab(tabId) {
    chrome.tabs.remove(tabId).catch(function() {});
}

function waitForLoad(tabId, timeout) {
    return new Promise(function(resolve) {
        var timer = setTimeout(finish, timeout);
        function listener(id, change) {
            if (id === tabId && change.status === 'complete') finish();
        }
        function finish() {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
        }
        chrome.tabs.onUpdated.addListener(listener);
    });
}

function delay(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ---------- Parsing HTML ----------

// Undo the escaping used inside JSON and HTML attributes, so links stored in
// scripts (common on Wix/React sites) are found too
function unescapeHtml(html) {
    return html
        .replace(/\\u002f/gi, '/')
        .replace(/\\\//g, '/')
        .replace(/&#x2f;|&#47;/gi, '/')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"');
}

function findSocialUrls(html) {
    var text = unescapeHtml(html);
    var matches = text.match(/(?:https?:)?\/\/(?:[a-z]{2,3}\.|www\.|m\.|web\.)?(?:instagram\.com|facebook\.com|fb\.com|linkedin\.com)\/[^\s"'<>\\)]+/gi) || [];
    return matches.map(function(url) {
        return url.indexOf('//') === 0 ? 'https:' + url : url;
    });
}

function isSocialUrl(url) {
    return /^https?:\/\/(?:[a-z]{2,3}\.|www\.|m\.|web\.)?(?:instagram\.com|facebook\.com|fb\.com|linkedin\.com)\//i.test(url || '');
}

// Accounts of website builders/hosts that appear on many sites' templates
var IGNORED_ACCOUNTS = /\/(wix|wixcom|wix-com|squarespace|wordpress|wordpressdotcom|godaddy|shopify|hostinger|webflow|elementor|facebook|instagram|linkedin|meta)\/?$/i;

// Returns 'instagram', 'facebook', 'linkedin' or '' for a URL that points to
// a profile/page (not a share button, post, login page, etc.)
function socialType(url) {
    if (!url) return '';
    url = url.replace(/[.,;]+$/, '');
    var clean = url.split(/[?#]/)[0].replace(/\/+$/, '');
    if (IGNORED_ACCOUNTS.test(clean)) return '';

    if (/^https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.]{2,30}$/i.test(clean) &&
        !/instagram\.com\/(p|reel|reels|explore|accounts|about|developer|legal|stories|tv|direct|web)$/i.test(clean)) {
        return 'instagram';
    }
    if (/^https?:\/\/(?:www\.|m\.|web\.)?(?:facebook|fb)\.com\/./i.test(url) &&
        !/(?:facebook|fb)\.com\/(sharer|share|dialog|plugins|tr|login|policies|help|privacy|legal|business|watch|events|groups|hashtag|photo|photos|story\.php|permalink\.php|home\.php|l\.php|v\d)/i.test(url) &&
        !/(?:facebook|fb)\.com\/\d{4}\//i.test(url) &&
        !/\.(js|css|png|jpe?g|gif|svg|webp)$/i.test(clean)) {
        return 'facebook';
    }
    if (/^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(company|in|school)\/[^\/]+/i.test(clean) &&
        !/linkedin\.com\/company\/(linkedin|wix-com|shopify)/i.test(clean)) {
        return 'linkedin';
    }
    return '';
}

function findContactPages(page) {
    var text = unescapeHtml(page.html);
    var urls = [];
    var hrefRegex = /<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    var match;
    var host;
    try { host = new URL(page.url).hostname; } catch (e) { return urls; }
    while ((match = hrefRegex.exec(text))) {
        var label = (match[1] + ' ' + match[2].replace(/<[^>]+>/g, ' ')).toLowerCase();
        if (!/contact|about|reach|get-in-touch|enquir|inquir/.test(label)) continue;
        try {
            var url = new URL(match[1], page.url);
            url.hash = '';
            if (url.hostname === host && urls.indexOf(url.href) === -1) urls.push(url.href);
        } catch (e) {}
    }
    return urls;
}

function extractEmails(html) {
    var text = unescapeHtml(html);
    var found = [];

    // Cloudflare-protected emails
    var cfRegex = /data-cfemail=["']([0-9a-f]+)["']/gi;
    var match;
    while ((match = cfRegex.exec(text))) {
        found.push(decodeCloudflareEmail(match[1]));
    }
    var cfLinkRegex = /\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi;
    while ((match = cfLinkRegex.exec(text))) {
        found.push(decodeCloudflareEmail(match[1]));
    }

    // mailto: links (may be URL-encoded) and plain emails
    text = text.replace(/mailto:([^"'?\s>]+)/gi, function(all, address) {
        try { return 'mailto:' + decodeURIComponent(address); } catch (e) { return all; }
    });
    found = found.concat(text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []);

    var unique = [];
    found.forEach(function(email) {
        email = email.trim().toLowerCase().replace(/^[^a-z0-9]+|[^a-z]+$/g, '');
        if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return;
        if (/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(email)) return;
        if (/(example\.|sentry|wixpress|domain\.com|email\.com|yourdomain|yoursite|@2x|@3x)/.test(email)) return;
        if (unique.indexOf(email) === -1) unique.push(email);
    });
    return unique.slice(0, 3);
}

function decodeCloudflareEmail(encoded) {
    var key = parseInt(encoded.substr(0, 2), 16);
    var email = '';
    for (var i = 2; i < encoded.length; i += 2) {
        email += String.fromCharCode(parseInt(encoded.substr(i, 2), 16) ^ key);
    }
    return email;
}
