'use client'

import { useState, useEffect } from 'react'

export default function CoatingsPage() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [aiAnswer, setAiAnswer] = useState<string>('')
  const [searchIntent, setSearchIntent] = useState<string>('')
  const [specificAnswer, setSpecificAnswer] = useState<any>(null)
  const [comparisonData, setComparisonData] = useState<any>(null)
  const [analyticalData, setAnalyticalData] = useState<any>(null)
  const [hasSearched, setHasSearched] = useState(false)
  const [searchProgress, setSearchProgress] = useState('')
  const [searchTime, setSearchTime] = useState<number | null>(null)
  
  const [selectedFamily, setSelectedFamily] = useState('')
  const [selectedProductType, setSelectedProductType] = useState('')
  const [selectedProductModel, setSelectedProductModel] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  
  const [familyOptions, setFamilyOptions] = useState<string[]>([])
  const [productTypeOptions, setProductTypeOptions] = useState<string[]>([])
  const [productModelOptions, setProductModelOptions] = useState<string[]>([])
  const [loadingFilters, setLoadingFilters] = useState(true)

  const [metaQuestionData, setMetaQuestionData] = useState<any>(null)

  useEffect(() => {
    loadFilterOptionsInline()
  }, [])

  // Enhanced markdown rendering function with improved readability for AI analysis
  const renderMarkdown = (markdown: string, colorClass: string = 'green'): string => {
    let html = markdown;
    
    // Color class mappings (Tailwind-safe - no dynamic classes)
    const colors: { [key: string]: { heading: string; text: string; bold: string } } = {
      green: { heading: 'text-green-800', text: 'text-green-900', bold: 'text-green-900' },
      indigo: { heading: 'text-indigo-800', text: 'text-indigo-900', bold: 'text-indigo-900' },
      purple: { heading: 'text-purple-800', text: 'text-purple-900', bold: 'text-purple-900' },
      blue: { heading: 'text-blue-800', text: 'text-blue-900', bold: 'text-blue-900' }
    };
    
    const color = colors[colorClass] || colors.green;
    
    // 1. Handle markdown tables FIRST (before other replacements)
    const tablePattern = /\n\|(.+)\|\n\|[\-:\s|]+\|\n((?:\|.+\|\n?)+)/g;
    html = html.replace(tablePattern, (match, header, rows) => {
      const headerCells = header
        .split('|')
        .map((cell: string) => cell.trim())
        .filter((cell: string) => cell !== '' && cell !== '-');
      
      const bodyRowsArray = rows.trim().split('\n').map((row: string) => {
        const cells = row
          .split('|')
          .map((cell: string) => cell.trim())
          .filter((cell: string) => cell !== '' && cell !== '-');
        return cells;
      });
      
      const headerHTML = headerCells
        .map((cell: string) => 
          `<th class="px-4 py-3 text-left text-sm font-semibold text-gray-700 border-b-2 border-gray-300 bg-gray-50">${cell}</th>`
        )
        .join('');
      
      const bodyHTML = bodyRowsArray
        .map((cells: string[]) => {
          const cellsHTML = cells
            .map((cell: string) => 
              `<td class="px-4 py-3 text-sm text-gray-800 border-b border-gray-200">${cell || '-'}</td>`
            )
            .join('');
          return `<tr class="hover:bg-gray-50">${cellsHTML}</tr>`;
        })
        .join('');
      
      return `<div class="overflow-x-auto my-6 rounded-lg shadow-sm"><table class="min-w-full bg-white border border-gray-300 rounded-lg"><thead><tr>${headerHTML}</tr></thead><tbody>${bodyHTML}</tbody></table></div>`;
    });
    
    // 2. Handle headings with better spacing
    html = html.replace(/### (.*?)(\n|$)/g, `<h3 class="text-xl font-bold ${color.heading} mt-6 mb-3">$1</h3>`);
    html = html.replace(/## (.*?)(\n|$)/g, `<h2 class="text-2xl font-bold ${color.text} mt-6 mb-4">$1</h2>`);
    html = html.replace(/# (.*?)(\n|$)/g, `<h1 class="text-3xl font-bold ${color.text} mt-6 mb-4">$1</h1>`);
    
    // 3. Handle bold text
    html = html.replace(/\*\*(.*?)\*\*/g, `<strong class="font-bold ${color.bold}">$1</strong>`);
    
    // 4. Clean up any existing bullet points (•) that AI might have added
    html = html.replace(/\n•\s*/g, '\n- ');
    html = html.replace(/^•\s*/gm, '- ');
    
    // 5. Handle section headers (text ending with colon)
    html = html.replace(/^([A-Z][^:\n]+):$/gm, `<div class="font-semibold text-lg ${color.text} mt-5 mb-3">$1:</div>`);
    
    // 6. Process lists - identify and convert list blocks
    const lines = html.split('\n');
    const processedLines: string[] = [];
    let inList = false;
    let listItems: string[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();
      
      // Skip if this line is part of a table (already processed)
      if (trimmedLine.startsWith('<div class="overflow-x-auto') || trimmedLine.startsWith('<table') || trimmedLine.includes('</table>')) {
        if (inList) {
          processedLines.push(
            '<ul class="space-y-2 my-4 pl-0">' +
            listItems.map(item => 
              `<li class="flex items-start"><span class="inline-block mr-3 mt-1 text-${colorClass}-600 flex-shrink-0">•</span><span class="flex-1">${item}</span></li>`
            ).join('') +
            '</ul>'
          );
          inList = false;
          listItems = [];
        }
        processedLines.push(line);
        continue;
      }
      
      // Check if this is a list item
      if (trimmedLine.startsWith('- ')) {
        if (!inList) {
          inList = true;
          listItems = [];
        }
        listItems.push(trimmedLine.substring(2).trim());
      } else {
        if (inList) {
          processedLines.push(
            '<ul class="space-y-2 my-4 pl-0">' +
            listItems.map(item => 
              `<li class="flex items-start"><span class="inline-block mr-3 mt-1 text-${colorClass}-600 flex-shrink-0">•</span><span class="flex-1">${item}</span></li>`
            ).join('') +
            '</ul>'
          );
          inList = false;
          listItems = [];
        }
        
        if (trimmedLine && !trimmedLine.startsWith('<')) {
          processedLines.push(`<p class="my-3 leading-relaxed">${line}</p>`);
        } else if (trimmedLine.startsWith('<')) {
          processedLines.push(line);
        } else {
          processedLines.push(line);
        }
      }
    }
    
    // Close any remaining open list
    if (inList && listItems.length > 0) {
      processedLines.push(
        '<ul class="space-y-2 my-4 pl-0">' +
        listItems.map(item => 
          `<li class="flex items-start"><span class="inline-block mr-3 mt-1 text-${colorClass}-600 flex-shrink-0">•</span><span class="flex-1">${item}</span></li>`
        ).join('') +
        '</ul>'
      );
    }
    
    html = processedLines.join('\n');
    
    // 7. Clean up empty paragraphs
    html = html.replace(/<p class="my-3 leading-relaxed"><\/p>/g, '');
    html = html.replace(/<p class="my-3 leading-relaxed">\s*<\/p>/g, '');
    
    // 8. Handle nested lists (sub-items with extra indentation)
    html = html.replace(/<li class="flex items-start"><span class="inline-block mr-3 mt-1 text-[^"]*-600 flex-shrink-0">•<\/span><span class="flex-1">\s*-\s*/g, 
      '<li class="flex items-start ml-6"><span class="inline-block mr-3 mt-1 text-gray-500 flex-shrink-0">◦</span><span class="flex-1">');
    
    return html;
  }

  const loadFilterOptionsInline = async () => {
    setLoadingFilters(true)
    try {
      const response = await fetch('/api/coatings-smart-search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          query: '__GET_FILTER_OPTIONS__',
          getFilterOptions: true
        }),
      })
      
      if (response.ok) {
        const data = await response.json()
        if (data.filterOptions) {
          setFamilyOptions(data.filterOptions.families || [])
          setProductTypeOptions(data.filterOptions.productTypes || [])
          setProductModelOptions(data.filterOptions.productModels || [])
          console.log('✅ Loaded coatings filter options:', data.filterOptions)
        }
      } else {
        console.error('Failed to load coatings filter options:', response.status)
      }
    } catch (err) {
      console.error('Failed to load coatings filter options:', err)
    } finally {
      setLoadingFilters(false)
    }
  }

  const handleSearch = async () => {
    if (!query.trim()) {
      setError('Please enter a search query')
      return
    }

    setLoading(true)
    setError('')
    setResults([])
    setAiAnswer('')
    setSearchIntent('')
    setSpecificAnswer(null)
    setComparisonData(null)
    setAnalyticalData(null)
    setMetaQuestionData(null)
    setHasSearched(true)
    setSearchProgress('Analyzing query...')
    
    const startTime = Date.now()

    try {
      const response = await fetch('/api/coatings-smart-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: query.trim(),
          filters: {
            family: selectedFamily,
            productType: selectedProductType,
            productModel: selectedProductModel
          }
        })
      })

      const data = await response.json()

      // 🔍 DEBUG - Remove after testing
      console.log('🔍 Full Response:', data)
      console.log('✨ AI Answer exists?', !!data.answer)
      console.log('✨ AI Answer length:', data.answer?.length)
      console.log('✨ AI Answer preview:', data.answer?.substring(0, 200))

      if (data.success) {
        setResults(data.products || [])
        setAiAnswer(data.answer || '')
        setSearchIntent(data.intent || '')
        
        const endTime = Date.now()
        setSearchTime((endTime - startTime) / 1000)
        
        console.log('✅ Search completed')
        console.log('📊 Products:', data.products?.length)
        console.log('✨ AI Answer:', data.answer?.substring(0, 100) + '...')
        console.log('🎯 Intent:', data.intent)
      } else {
        setError(data.error || 'Search failed')
      }
    } catch (err: any) {
      console.error('Search error:', err)
      setError(err.message || 'An error occurred')
    } finally {
      setLoading(false)
      setSearchProgress('')
    }
  }

  const fetchFilteredProducts = async (filter: { filterType: string; filterValue: string }) => {
    try {
      console.log(`🔍 Fetching products with ${filter.filterType} = ${filter.filterValue}`)
      
      const searchQuery = `products in ${filter.filterValue} ${filter.filterType}`
      
      const response = await fetch('/api/coatings-smart-search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          query: searchQuery,
          family: filter.filterType === 'family' ? filter.filterValue : '',
          productType: filter.filterType === 'type' ? filter.filterValue : '',
          productModel: filter.filterType === 'model' ? filter.filterValue : ''
        }),
      })

      if (response.ok) {
        const data = await response.json()
        if (data.products && data.products.length > 0) {
          console.log(`✅ Fetched ${data.products.length} products`)
          setResults(data.products)
        }
      }
    } catch (err) {
      console.error('Error fetching filtered products:', err)
    }
  }

  const clearFilters = () => {
    setSelectedFamily('')
    setSelectedProductType('')
    setSelectedProductModel('')
  }

  const hasActiveFilters = selectedFamily || selectedProductType || selectedProductModel

  const isEmpty = (value: any): boolean => {
    if (value === null || value === undefined) return true
    if (typeof value === 'string' && value.trim() === '') return true
    if (Array.isArray(value) && value.length === 0) return true
    return false
  }

  const groupAttributes = (product: any) => {
    const headerFieldsOrder = ['sku', 'product_name', 'productname', 'name', 'product_description', 'description']
    const excludeFields = ['embedding', 'created_at', 'updated_at', 'createdat', 'updatedat', 'searchable_text', 'searchabletext', 'searchable', '_sourceTable']
    
    const header: any = {}
    const other: any = {}
    const seen = new Set<string>()

    const headerCandidates: { [key: string]: any } = {}
    
    Object.entries(product).forEach(([key, value]) => {
      const lowerKey = key.toLowerCase()
      
      if (seen.has(lowerKey) || excludeFields.includes(lowerKey) || isEmpty(value)) return
      seen.add(lowerKey)
      
      if (headerFieldsOrder.includes(lowerKey)) {
        headerCandidates[lowerKey] = { originalKey: key, value }
      } else {
        other[key] = value
      }
    })

    headerFieldsOrder.forEach(fieldName => {
      if (headerCandidates[fieldName]) {
        const { originalKey, value } = headerCandidates[fieldName]
        header[originalKey] = value
      }
    })

    return { header, other }
  }

  const formatFieldName = (key: string): string => {
    const fieldMappings: { [key: string]: string } = {
      'sku': 'SKU',
      'product_name': 'Product Name',
      'productname': 'Product Name',
      'product_description': 'Description',
      'description': 'Description',
      'product_model': 'Product Model',
      'productmodel': 'Product Model',
      'product_type': 'Product Type',
      'producttype': 'Product Type',
    }
    
    const lowerKey = key.toLowerCase()
    if (fieldMappings[lowerKey]) {
      return fieldMappings[lowerKey]
    }
    
    return key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase())
  }

  const formatValue = (key: string, value: any): string => {
    const lowerKey = key.toLowerCase()
    if ((lowerKey.includes('created') || lowerKey.includes('updated')) && 
        typeof value === 'string' && value.includes('T')) {
      try {
        return new Date(value).toLocaleString()
      } catch {
        return String(value)
      }
    }
    return String(value)
  }

  const getAllKeys = (products: any[]) => {
    const allKeys = new Set<string>()
    const seenLowerKeys = new Set<string>()
    const excludeFields = ['embedding', 'created_at', 'updated_at', 'createdat', 'updatedat', 'searchable_text', 'searchabletext', '_sourceTable']
    
    products.forEach(product => {
      Object.keys(product).forEach(key => {
        const lowerKey = key.toLowerCase()
        if (!seenLowerKeys.has(lowerKey) && !excludeFields.includes(lowerKey) && !isEmpty(product[key])) {
          allKeys.add(key)
          seenLowerKeys.add(lowerKey)
        }
      })
    })
    return Array.from(allKeys)
  }

  const isDifferent = (key: string, products: any[]) => {
    const values = products.map(p => p[key])
    return new Set(values).size > 1
  }

  const scrollToProducts = () => {
    const element = document.getElementById('product-references')
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  // 🎯 NEW: Render AI Summary (Primary Display)
  const renderAISummary = () => {
    if (!aiAnswer || comparisonData || analyticalData || metaQuestionData) return null

    return (
      <div className="mb-8 bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl shadow-lg overflow-hidden border border-indigo-100">
        {/* Header */}
        <div className="bg-gradient-to-r from-indigo-600 to-purple-600 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <span className="text-3xl">✨</span>
              <div>
                <h3 className="text-xl font-bold text-white">
                  AI Summary
                </h3>
                <p className="text-indigo-100 text-sm">
                  {searchIntent === 'comparison' && 'Product Comparison'}
                  {searchIntent === 'lookup' && 'Product Information'}
                  {searchIntent === 'list' && 'Product Catalog'}
                  {searchIntent === 'count' && 'Product Count'}
                  {searchIntent === 'analytical' && 'Expert Recommendation'}
                  {!searchIntent && 'Search Results'}
                </p>
              </div>
            </div>
            
            {/* Search Stats */}
            <div className="text-right">
              <div className="text-white text-sm font-semibold">
                {results.length} Products Found
              </div>
              {searchTime && (
                <div className="text-indigo-200 text-xs">
                  {searchTime.toFixed(1)}s response time
                </div>
              )}
            </div>
          </div>
        </div>

        {/* AI Answer Content */}
        <div className="px-6 py-6">
          <div 
            className="prose prose-indigo max-w-none"
            dangerouslySetInnerHTML={{ 
              __html: renderMarkdown(aiAnswer, 'indigo') 
            }}
          />
        </div>

        {/* Footer */}
        <div className="bg-indigo-50 px-6 py-3 border-t border-indigo-100">
          <div className="flex items-center justify-between text-sm text-indigo-700">
            <div className="flex items-center space-x-2">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
              </svg>
              <span>AI-generated summary based on {results.length} matching products</span>
            </div>
            <button
              onClick={scrollToProducts}
              className="text-indigo-600 hover:text-indigo-800 font-medium"
            >
              View Products →
            </button>
          </div>
        </div>
      </div>
    )
  }

  const renderAnalyticalSummary = () => {
    if (!analyticalData) return null

    return (
      <div className="mb-8">
        <div className="bg-gradient-to-r from-green-50 to-emerald-50 border-l-4 border-green-500 rounded-lg overflow-hidden shadow-lg">
          <div className="p-4 sm:p-6">
            <div className="flex items-start mb-4">
              <div className="flex-shrink-0">
                <svg className="h-6 w-6 sm:h-8 sm:w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
              <div className="ml-3 sm:ml-4 flex-1">
                <h2 className="text-xl sm:text-2xl font-bold text-green-900 mb-2">AI Summary</h2>
                <p className="text-green-700 text-xs sm:text-sm">
                  Based on analysis of {analyticalData.count} coating product(s)
                  {searchTime && <span className="ml-2">• Completed in {searchTime}s</span>}
                </p>
              </div>
            </div>
            
            <div className="prose prose-green max-w-none text-sm sm:text-base">
              <div 
                className="text-gray-800 leading-relaxed"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(analyticalData.summary, 'green') }}
              />
            </div>
          </div>
        </div>

        {analyticalData.count > 0 && (
          <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-3 sm:p-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="flex items-center">
                <svg className="h-5 w-5 text-blue-600 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-xs sm:text-sm font-medium text-blue-900">
                  {analyticalData.count} coating product reference{analyticalData.count !== 1 ? 's' : ''} available below
                </span>
              </div>
              <button
                onClick={scrollToProducts}
                className="relative z-10 text-xs sm:text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 rounded px-3 py-1 transition-all cursor-pointer whitespace-nowrap"
                type="button"
              >
                View Details →
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderMetaSummary = () => {
    if (!metaQuestionData) return null

    return (
      <div className="mb-8">
        <div className="bg-gradient-to-r from-indigo-50 to-purple-50 border-l-4 border-indigo-500 rounded-lg overflow-hidden shadow-lg">
          <div className="p-4 sm:p-6">
            <div className="flex items-start mb-4">
              <div className="flex-shrink-0">
                <svg className="h-6 w-6 sm:h-8 sm:w-8 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </div>
              <div className="ml-3 sm:ml-4 flex-1">
                <h2 className="text-xl sm:text-2xl font-bold text-indigo-900 mb-2">Database Information</h2>
                <p className="text-indigo-700 text-xs sm:text-sm">
                  {metaQuestionData.metaType === 'count' && 'Product count summary'}
                  {metaQuestionData.metaType === 'list' && 'Available product categories'}
                  {metaQuestionData.metaType === 'overview' && 'Complete database overview'}
                  {searchTime && <span className="ml-2">• Retrieved in {searchTime}s</span>}
                </p>
              </div>
            </div>
            
            <div className="prose prose-indigo max-w-none text-sm sm:text-base">
              <div 
                className="text-gray-800 leading-relaxed"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(metaQuestionData.summary, 'indigo') }}
              />
            </div>

            {metaQuestionData.count !== undefined && (
              <div className="mt-4 pt-4 border-t border-indigo-200">
                <div className="flex items-center gap-2">
                  <span className="text-xs sm:text-sm font-medium text-indigo-700">Total Count:</span>
                  <span className="bg-indigo-100 text-indigo-800 px-3 py-1 rounded-full font-semibold text-sm">
                    {metaQuestionData.count.toLocaleString()}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {results.length > 0 && (
          <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-3 sm:p-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="flex items-center">
                <svg className="h-5 w-5 text-blue-600 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-xs sm:text-sm font-medium text-blue-900">
                  {results.length} coating product reference{results.length !== 1 ? 's' : ''} available below
                </span>
              </div>
              <button
                onClick={scrollToProducts}
                className="relative z-10 text-xs sm:text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 rounded px-3 py-1 transition-all cursor-pointer whitespace-nowrap"
                type="button"
              >
                View Details →
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderComparison = () => {
    if (!comparisonData || !comparisonData.products || comparisonData.products.length < 2) {
      return null
    }

    const products = comparisonData.products
    const allKeys = getAllKeys(products)
    
    const priorityFieldsOrder = ['sku', 'product_name', 'productname', 'name', 'product_description', 'description']
    
    const priority = allKeys
      .filter(k => priorityFieldsOrder.includes(k.toLowerCase()))
      .sort((a, b) => {
        const indexA = priorityFieldsOrder.indexOf(a.toLowerCase())
        const indexB = priorityFieldsOrder.indexOf(b.toLowerCase())
        return indexA - indexB
      })
    
    const technical = allKeys.filter(k => !priorityFieldsOrder.includes(k.toLowerCase()))

    return (
      <div className="mb-8">
        <div className="mb-6 bg-gradient-to-r from-blue-50 to-indigo-50 border-l-4 border-blue-500 p-4 sm:p-6 rounded-lg">
          <h2 className="text-xl sm:text-2xl font-bold text-blue-900 mb-2">Coating Product Comparison</h2>
          <p className="text-blue-700 text-xs sm:text-sm">
            Comparing {products.length} coating products - Differences are highlighted
            {searchTime && <span className="ml-2">• Completed in {searchTime}s</span>}
          </p>
        </div>

        {comparisonData.summary && (
          <div className="mb-6 bg-gradient-to-r from-purple-50 to-pink-50 border-l-4 border-purple-500 rounded-lg overflow-hidden shadow-lg">
            <div className="p-4 sm:p-6">
              <div className="flex items-start mb-4">
                <div className="flex-shrink-0">
                  <svg className="h-6 w-6 sm:h-8 sm:w-8 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                </div>
                <div className="ml-3 sm:ml-4 flex-1">
                  <h3 className="text-lg sm:text-xl font-bold text-purple-900 mb-2">AI Comparison Analysis</h3>
                  <p className="text-purple-700 text-xs sm:text-sm">
                    Detailed comparison of {products.length} products
                  </p>
                </div>
              </div>
              
              <div className="prose prose-purple max-w-none text-sm sm:text-base">
                <div 
                  className="text-gray-800 leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(comparisonData.summary, 'purple') }}
                />
              </div>
            </div>
          </div>
        )}

        <div className="bg-white rounded-lg shadow-lg overflow-hidden border border-gray-200">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px]">
              <thead>
                <tr className="bg-gray-50 border-b-2 border-gray-200">
                  <th className="px-3 sm:px-6 py-3 sm:py-4 text-left text-xs sm:text-sm font-semibold text-gray-700 sticky left-0 bg-gray-50 z-10">
                    Attribute
                  </th>
                  {products.map((product: any, idx: number) => (
                    <th 
                      key={idx} 
                      className="px-3 sm:px-6 py-3 sm:py-4 text-left text-xs sm:text-sm font-semibold"
                      style={{ color: '#0078a9' }}
                    >
                      <div className="font-bold">{product.sku || product.Product_Name || `Product ${idx + 1}`}</div>
                      {product.family && (
                        <div className="text-xs font-normal text-gray-600 mt-1">Family: {product.family}</div>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {priority.map((key) => {
                  const different = isDifferent(key, products)
                  return (
                    <tr 
                      key={key} 
                      className={`border-b border-gray-200 ${different ? 'bg-yellow-50' : 'hover:bg-gray-50'}`}
                    >
                      <td className="px-3 sm:px-6 py-3 sm:py-4 text-xs sm:text-sm font-semibold text-gray-700 sticky left-0 bg-white z-10">
                        <div className="flex items-center gap-2">
                          {formatFieldName(key)}
                          {different && (
                            <span className="inline-block w-2 h-2 bg-yellow-500 rounded-full flex-shrink-0" title="Different values"></span>
                          )}
                        </div>
                      </td>
                      {products.map((product: any, idx: number) => (
                        <td 
                          key={idx} 
                          className={`px-3 sm:px-6 py-3 sm:py-4 text-xs sm:text-sm text-gray-900 ${different ? 'font-semibold' : ''}`}
                        >
                          {formatValue(key, product[key]) || '-'}
                        </td>
                      ))}
                    </tr>
                  )
                })}

                {technical.length > 0 && (
                  <>
                    <tr className="bg-gray-100">
                      <td colSpan={products.length + 1} className="px-3 sm:px-6 py-3 text-xs font-bold uppercase tracking-wide" style={{ color: '#0078a9' }}>
                        Technical Specifications
                      </td>
                    </tr>

                    {technical.map((key) => {
                      const different = isDifferent(key, products)
                      return (
                        <tr 
                          key={key} 
                          className={`border-b border-gray-200 ${different ? 'bg-yellow-50' : 'hover:bg-gray-50'}`}
                        >
                          <td className="px-3 sm:px-6 py-3 text-xs sm:text-sm text-gray-700 sticky left-0 bg-white z-10">
                            <div className="flex items-center gap-2">
                              {formatFieldName(key)}
                              {different && (
                                <span className="inline-block w-2 h-2 bg-yellow-500 rounded-full flex-shrink-0" title="Different values"></span>
                              )}
                            </div>
                          </td>
                          {products.map((product: any, idx: number) => (
                            <td 
                              key={idx} 
                              className={`px-3 sm:px-6 py-3 text-xs sm:text-sm text-gray-900 ${different ? 'font-semibold' : ''}`}
                            >
                              {formatValue(key, product[key]) || '-'}
                            </td>
                          ))}
                        </tr>
                      )
                    })}
                  </>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 text-xs sm:text-sm text-gray-600">
          <span className="inline-block w-3 h-3 bg-yellow-50 border border-yellow-200 rounded flex-shrink-0"></span>
          <span>Highlighted rows indicate differences between coating products</span>
        </div>
      </div>
    )
  }

  const renderLookupSummary = () => {
    if (!specificAnswer || comparisonData || analyticalData || metaQuestionData) return null

    return (
      <div className="mb-8">
        <div className="bg-gradient-to-r from-green-50 to-emerald-50 border-l-4 border-green-500 rounded-lg overflow-hidden shadow-lg">
          <div className="p-4 sm:p-6">
            <div className="flex items-start mb-4">
              <div className="flex-shrink-0">
                <svg className="h-6 w-6 sm:h-8 sm:w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
              <div className="ml-3 sm:ml-4 flex-1">
                <h2 className="text-xl sm:text-2xl font-bold text-green-900 mb-2">AI Analysis</h2>
                <p className="text-green-700 text-xs sm:text-sm">
                  Based on analysis of {specificAnswer.count} coating product(s)
                  {searchTime && <span className="ml-2">• Completed in {searchTime}s</span>}
                </p>
              </div>
            </div>
            
            <div className="prose prose-green max-w-none text-sm sm:text-base">
              <div 
                className="text-gray-800 leading-relaxed"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(specificAnswer.summary, 'green') }}
              />
            </div>
          </div>
        </div>

        {specificAnswer.count > 0 && (
          <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-3 sm:p-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="flex items-center">
                <svg className="h-5 w-5 text-blue-600 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-xs sm:text-sm font-medium text-blue-900">
                  {specificAnswer.count} coating product reference{specificAnswer.count !== 1 ? 's' : ''} available below
                </span>
              </div>
              <button
                onClick={scrollToProducts}
                className="relative z-10 text-xs sm:text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 rounded px-3 py-1 transition-all cursor-pointer whitespace-nowrap"
                type="button"
              >
                View Details →
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <main className="min-h-screen p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto bg-gray-50">
      <div className="bg-white rounded-lg shadow-sm p-4 sm:p-6 lg:p-8 mb-6 sm:mb-8">
        <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold mb-2 text-center" style={{ color: '#0078a9' }}>
          Coatings Smart Search
        </h1>
        <p className="text-center text-gray-600 mb-6 sm:mb-8 text-sm sm:text-base">
          Search coating products using natural language • Powered by AI
        </p>

        <form onSubmit={(e) => { e.preventDefault(); handleSearch(); }}>
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-4 mb-4">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ask anything... (e.g., 'Best coating for corrosion protection')"
              className="flex-1 px-3 sm:px-4 py-2 sm:py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0078a9] focus:border-transparent text-sm sm:text-base"
            />
            <div className="flex gap-2 sm:gap-4">
              <button
                type="button"
                onClick={() => setShowFilters(!showFilters)}
                className="flex-1 sm:flex-none px-4 sm:px-6 py-2 sm:py-3 border-2 rounded-lg font-medium transition-colors text-sm sm:text-base"
                style={{ 
                  borderColor: '#0078a9',
                  color: showFilters ? '#fff' : '#0078a9',
                  backgroundColor: showFilters ? '#0078a9' : 'transparent'
                }}
              >
                <svg className="w-4 h-4 sm:w-5 sm:h-5 inline-block mr-1 sm:mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                </svg>
                <span className="hidden sm:inline">Filters</span>
                <span className="sm:hidden">Filter</span>
                {hasActiveFilters && (
                  <span className="ml-1 sm:ml-2 inline-flex items-center justify-center w-4 h-4 sm:w-5 sm:h-5 text-xs font-bold text-white bg-red-500 rounded-full">
                    {[selectedFamily, selectedProductType, selectedProductModel].filter(Boolean).length}
                  </span>
                )}
              </button>
              <button
                type="submit"
                disabled={loading || !query.trim()}
                className="flex-1 sm:flex-none px-6 sm:px-8 py-2 sm:py-3 text-white rounded-lg hover:opacity-90 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium transition-colors text-sm sm:text-base"
                style={{ backgroundColor: '#0078a9' }}
              >
                {loading ? 'Searching...' : 'Search'}
              </button>
            </div>
          </div>

          {showFilters && (
            <div className="border border-gray-200 rounded-lg p-4 sm:p-6 bg-gray-50">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-4 gap-2">
                <h3 className="text-base sm:text-lg font-semibold" style={{ color: '#0078a9' }}>
                  Filter Options {loadingFilters && <span className="text-xs sm:text-sm font-normal text-gray-500">(Loading...)</span>}
                </h3>
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="text-xs sm:text-sm text-red-600 hover:text-red-800 font-medium"
                  >
                    Clear All Filters
                  </button>
                )}
              </div>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                    Family ({familyOptions.length} options)
                  </label>
                  <select
                    value={selectedFamily}
                    onChange={(e) => setSelectedFamily(e.target.value)}
                    disabled={loadingFilters}
                    className="w-full px-3 sm:px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0078a9] focus:border-transparent disabled:bg-gray-100 text-sm sm:text-base"
                  >
                    <option value="">All Families</option>
                    {familyOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                    Product Type ({productTypeOptions.length} options)
                  </label>
                  <select
                    value={selectedProductType}
                    onChange={(e) => setSelectedProductType(e.target.value)}
                    disabled={loadingFilters}
                    className="w-full px-3 sm:px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0078a9] focus:border-transparent disabled:bg-gray-100 text-sm sm:text-base"
                  >
                    <option value="">All Types</option>
                    {productTypeOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-2 lg:col-span-1">
                  <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                    Product Model ({productModelOptions.length} options)
                  </label>
                  <select
                    value={selectedProductModel}
                    onChange={(e) => setSelectedProductModel(e.target.value)}
                    disabled={loadingFilters}
                    className="w-full px-3 sm:px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0078a9] focus:border-transparent disabled:bg-gray-100 text-sm sm:text-base"
                  >
                    <option value="">All Models</option>
                    {productModelOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {hasActiveFilters && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="text-xs sm:text-sm text-gray-600">Active filters:</span>
                  {selectedFamily && (
                    <span className="inline-flex items-center px-2 sm:px-3 py-1 rounded-full text-xs sm:text-sm font-medium bg-blue-100 text-blue-800">
                      Family: {selectedFamily}
                      <button
                        type="button"
                        onClick={() => setSelectedFamily('')}
                        className="ml-1 sm:ml-2 text-blue-600 hover:text-blue-800"
                      >
                        ×
                      </button>
                    </span>
                  )}
                  {selectedProductType && (
                    <span className="inline-flex items-center px-2 sm:px-3 py-1 rounded-full text-xs sm:text-sm font-medium bg-green-100 text-green-800">
                      Type: {selectedProductType}
                      <button
                        type="button"
                        onClick={() => setSelectedProductType('')}
                        className="ml-1 sm:ml-2 text-green-600 hover:text-green-800"
                      >
                        ×
                      </button>
                    </span>
                  )}
                  {selectedProductModel && (
                    <span className="inline-flex items-center px-2 sm:px-3 py-1 rounded-full text-xs sm:text-sm font-medium bg-purple-100 text-purple-800">
                      Model: {selectedProductModel}
                      <button
                        type="button"
                        onClick={() => setSelectedProductModel('')}
                        className="ml-1 sm:ml-2 text-purple-600 hover:text-purple-800"
                      >
                        ×
                      </button>
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </form>
      </div>

      {loading && (
        <div className="text-center py-8 sm:py-12 bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="inline-block animate-spin rounded-full h-10 w-10 sm:h-12 sm:w-12 border-b-2 border-[#0078a9] mb-4"></div>
          <p className="text-base sm:text-lg font-medium text-gray-700">Searching coating products...</p>
          {searchProgress && (
            <p className="mt-2 text-xs sm:text-sm text-gray-600">{searchProgress}</p>
          )}
          <p className="mt-2 text-xs text-gray-400">Optimized search • Typically completes in 15-30 seconds</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border-l-4 border-red-500 p-4 sm:p-6 rounded-lg shadow-sm">
          <div className="flex items-start">
            <svg className="h-5 w-5 sm:h-6 sm:w-6 text-red-500 mr-3 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <h3 className="text-base sm:text-lg font-semibold text-red-800">Search Error</h3>
              <p className="text-red-700 mt-1 text-sm sm:text-base">{error}</p>
            </div>
          </div>
        </div>
      )}

      {!loading && !error && hasSearched && (
        <>
          {/* 🎯 NEW: AI Summary Display (Shows FIRST) */}
          {renderAISummary()}
          
          {/* Existing summary renderers */}
          {renderMetaSummary()}
          {renderAnalyticalSummary()}
          {renderLookupSummary()}
          {renderComparison()}

          {results.length > 0 && !comparisonData && (
            <div id="product-references" className="bg-white rounded-lg shadow-sm p-4 sm:p-6">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-4 sm:mb-6 gap-3">
                <h2 className="text-xl sm:text-2xl font-bold" style={{ color: '#0078a9' }}>
                  {analyticalData || metaQuestionData || aiAnswer ? 'Product References' : 'Search Results'}
                </h2>
                <div className="flex items-center gap-3 sm:gap-4">
                  {searchTime && (
                    <span className="text-xs sm:text-sm text-gray-500">
                      ⚡ {searchTime.toFixed(1)}s
                    </span>
                  )}
                  <span className="px-3 sm:px-4 py-1 sm:py-2 bg-blue-100 text-blue-800 rounded-full text-xs sm:text-sm font-semibold">
                    {results.length} {results.length === 1 ? 'Product' : 'Products'}
                  </span>
                </div>
              </div>

              <div className="space-y-4 sm:space-y-6">
                {results.map((product, index) => {
                  const { header, other } = groupAttributes(product)
                  
                  return (
                    <div 
                      key={index} 
                      className="border border-gray-200 rounded-lg p-4 sm:p-6 hover:shadow-md transition-shadow bg-gray-50"
                    >
                      <div className="mb-4 pb-4 border-b border-gray-300">
                        {Object.entries(header).map(([key, value]) => (
                          <div key={key} className="mb-2">
                            <span className="font-bold text-base sm:text-lg" style={{ color: '#0078a9' }}>
                              {formatFieldName(key)}:
                            </span>
                            <span 
                              className="ml-2 text-gray-800 text-base sm:text-lg break-words"
                              dangerouslySetInnerHTML={{ __html: formatValue(key, value) }}
                            />
                          </div>
                        ))}
                        {product._sourceTable && (
                          <div className="mt-2">
                            <span className="inline-block px-2 sm:px-3 py-1 bg-purple-100 text-purple-800 rounded-full text-xs font-semibold">
                              Found in: {product._sourceTable}
                            </span>
                          </div>
                        )}
                      </div>

                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
                        {Object.entries(other).map(([key, value]) => (
                          <div key={key} className="flex flex-col">
                            <span className="text-xs sm:text-sm font-semibold text-gray-600 mb-1">
                              {formatFieldName(key)}
                            </span>
                            <span 
                              className="text-xs sm:text-sm text-gray-800 bg-white p-2 rounded border border-gray-200 whitespace-pre-wrap break-words"
                              dangerouslySetInnerHTML={{ __html: formatValue(key, value) }}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {!loading && !error && hasSearched && results.length === 0 && !analyticalData && !metaQuestionData && !aiAnswer && (
            <div className="text-center py-8 sm:py-12 bg-white rounded-lg border border-gray-200 shadow-sm">
              <svg className="mx-auto h-12 w-12 sm:h-16 sm:w-16 text-gray-400 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h3 className="text-lg sm:text-xl font-semibold text-gray-700 mb-2">No Products Found</h3>
              <p className="text-gray-600 mb-4 text-sm sm:text-base px-4">
                We couldn't find any coating products matching your search.
              </p>
              <p className="text-xs sm:text-sm text-gray-500 px-4">
                Try adjusting your search terms or filters, or browse all products.
              </p>
            </div>
          )}
        </>
      )}
    </main>
  )
}
